/**
 * Virtual Workdir 路径解析与共享读视图
 *
 * 供 workdir.ts 与 write-tree.ts 复用：
 * - 路径解析（resolvePath / resolveWriteTarget*）
 * - 目录子项展开（listDirectoryChildren / getDirectoryChildrenView）
 * - origin 节点懒注册（ensureNodeFromTreeEntry）
 *
 * 目录观察与编译计划相关的类型和函数已拆分到 directory-view.ts。
 */

import {
  VirtualNotDirectoryError,
  VirtualNotFileError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
} from "../core/errors.ts";
import { originBackedNodeId, VIRTUAL_ROOT_NODE_ID } from "./ids.ts";
import { readRepoTree, treeEntryToNodeOrigin } from "./origin.ts";
import { mergeDirectoryChildren } from "./overlay.ts";
import {
  assertValidVirtualPath,
  baseName,
  joinPath,
  parentPath,
  splitPathSegments,
  VIRTUAL_ROOT_PATH,
} from "./path.ts";

import type { TreeEntry } from "../core/types.ts";
import type { ObjectSource } from "../core/types/odb.ts";
import type { NodeId } from "./ids.ts";
import type { DirectoryNodeState, FileNodeState, WorkdirNode, SymlinkNodeState } from "./nodes.ts";
import type { MergedDirectoryChild, OriginDirectoryChild } from "./overlay.ts";
import type { VirtualWorkdirStateStore } from "./state-store.ts";

type DirectoryWorkdirNode = WorkdirNode & { readonly state: DirectoryNodeState };
type LeafWorkdirNode = WorkdirNode & { readonly state: FileNodeState | SymlinkNodeState };

// ==================== 类型 ====================

export type ResolveResult =
  | { readonly found: false; readonly node: null }
  | { readonly found: true; readonly node: WorkdirNode };

export interface ResolvedDirectoryChild {
  readonly child: MergedDirectoryChild;
  readonly node: WorkdirNode;
}

export interface ResolvedLeafPath {
  readonly path: string;
  readonly node: LeafWorkdirNode;
}

export interface ResolvedWriteParentDirectory {
  readonly parentPath: string;
  readonly name: string;
  readonly parentNode: DirectoryWorkdirNode;
}

export interface ResolvedWriteTarget {
  readonly parentPath: string;
  readonly name: string;
  readonly parentNode: DirectoryWorkdirNode;
  readonly existing: ResolvedDirectoryChild | null;
}

export interface ResolvedExistingWriteTarget extends ResolvedWriteParentDirectory {
  readonly existing: ResolvedDirectoryChild;
}

export interface ResolvedLeafWriteTarget extends ResolvedWriteParentDirectory {
  readonly existing: {
    readonly child: MergedDirectoryChild;
    readonly node: LeafWorkdirNode;
  } | null;
}

export interface ResolvedWriteTransfer {
  readonly from: ResolvedExistingWriteTarget;
  readonly to: ResolvedWriteTarget;
}

interface ParentLookupContext {
  readonly parentPath: string;
  readonly name: string;
  readonly parentNode: WorkdirNode | null;
}

/**
 * 当前目录视图
 */
export interface DirectoryChildrenView {
  /** 当前目录下的有序子项 */
  readonly children: readonly MergedDirectoryChild[];
  /** 按名称读取单个子项 */
  get(name: string): MergedDirectoryChild | undefined;
}

// ==================== 工具函数 ====================

/**
 * 基于目录路径与子项名称拼出子路径。
 *
 * @example
 * ```ts
 * expect(joinChildPath("", "a.txt")).toBe("a.txt");
 * expect(joinChildPath("src", "a.txt")).toBe("src/a.txt");
 * ```
 */
export function joinChildPath(dirPath: string, name: string): string {
  return dirPath === VIRTUAL_ROOT_PATH ? name : `${dirPath}/${name}`;
}

export function getRootNode(state: VirtualWorkdirStateStore): WorkdirNode {
  const root = state.getNode(VIRTUAL_ROOT_NODE_ID);
  if (root === null) {
    throw new Error("Virtual workdir is missing root node");
  }
  return root;
}

/**
 * 从根目录沿路径分段解析到目标节点
 */
export function resolvePath(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  path: string,
): ResolveResult {
  assertValidVirtualPath(path);
  const segments = splitPathSegments(path);
  let current = getRootNode(state);
  let currentPath = VIRTUAL_ROOT_PATH;

  for (const segment of segments) {
    if (current.state.kind !== "directory") {
      return { found: false, node: null };
    }
    const child = getDirectoryChildrenView(source, state, current, currentPath).get(segment);
    if (child === undefined) {
      return { found: false, node: null };
    }
    currentPath = joinPath(currentPath === VIRTUAL_ROOT_PATH ? null : currentPath, segment);
    const childNode = state.getNode(child.nodeId);
    if (childNode === null) {
      return { found: false, node: null };
    }
    current = childNode;
  }

  return { found: true, node: current };
}

/**
 * 解析写路径的父目录，并保证其存在且为目录。
 *
 * @example
 * ```ts
 * const target = resolveWriteParentDirectory(source, state, "src/a.txt");
 * expect(target.parentPath).toBe("src");
 * expect(target.name).toBe("a.txt");
 * ```
 */
export function resolveWriteParentDirectory(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  path: string,
): ResolvedWriteParentDirectory {
  const target = resolvePathParentLookupContext(source, state, path);
  if (target.parentNode === null) {
    throw new VirtualPathNotFoundError(target.parentPath || path);
  }
  if (target.parentNode.state.kind !== "directory") {
    throw new VirtualNotDirectoryError(target.parentPath || path);
  }

  return {
    parentPath: target.parentPath,
    name: target.name,
    parentNode: target.parentNode as DirectoryWorkdirNode,
  };
}

/**
 * 解析写路径对应的父目录与当前可见目标子项。
 *
 * @example
 * ```ts
 * const target = resolveWriteTargetInParent(source, state, "src/a.txt");
 * expect(target.parentPath).toBe("src");
 * ```
 */
export function resolveWriteTargetInParent(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  path: string,
): ResolvedWriteTarget {
  const parent = resolveWriteParentDirectory(source, state, path);
  const existing = resolveDirectoryChild(
    source,
    state,
    parent.parentNode,
    parent.parentPath,
    parent.name,
  );

  return {
    ...parent,
    existing: existing.found ? existing : null,
  };
}

/**
 * 解析写路径，并要求当前目标已存在。
 *
 * @example
 * ```ts
 * const target = requireExistingWriteTarget(source, state, "a.txt");
 * expect(target.existing.child.name).toBe("a.txt");
 * ```
 */
export function requireExistingWriteTarget(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  path: string,
): ResolvedExistingWriteTarget {
  const target = resolveWriteTargetInParent(source, state, path);
  if (target.existing === null) {
    throw new VirtualPathNotFoundError(path);
  }
  return {
    parentPath: target.parentPath,
    name: target.name,
    parentNode: target.parentNode,
    existing: target.existing,
  };
}

/**
 * 解析写路径，并要求目标当前不存在。
 *
 * @example
 * ```ts
 * const target = requireMissingWriteTarget(source, state, "a.txt");
 * expect(target.name).toBe("a.txt");
 * ```
 */
export function requireMissingWriteTarget(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  path: string,
): ResolvedWriteParentDirectory {
  const target = resolveWriteTargetInParent(source, state, path);
  if (target.existing !== null) {
    throw new VirtualPathAlreadyExistsError(path);
  }
  return {
    parentPath: target.parentPath,
    name: target.name,
    parentNode: target.parentNode,
  };
}

/**
 * 解析允许写入 blob/symlink 的目标。
 *
 * 若目标已存在且为目录，则抛出 `VirtualNotFileError`。
 *
 * @example
 * ```ts
 * const target = resolveLeafWriteTarget(source, state, "a.txt");
 * expect(target.name).toBe("a.txt");
 * ```
 */
export function resolveLeafWriteTarget(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  path: string,
): ResolvedLeafWriteTarget {
  const target = resolveWriteTargetInParent(source, state, path);
  if (target.existing !== null && target.existing.node.state.kind === "directory") {
    throw new VirtualNotFileError(path);
  }
  return {
    parentPath: target.parentPath,
    name: target.name,
    parentNode: target.parentNode,
    existing:
      target.existing === null
        ? null
        : { child: target.existing.child, node: target.existing.node as LeafWorkdirNode },
  };
}

/**
 * 按路径定向解析当前叶子节点。
 *
 * 目录或不存在的路径都会返回 `null`。
 *
 * @example
 * ```ts
 * const leaf = resolveCurrentLeafAtPath(source, state, "a.txt");
 * expect(leaf?.node.state.kind).toBe("file");
 * ```
 */
export function resolveCurrentLeafAtPath(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  path: string,
): ResolvedLeafPath | null {
  const resolved = resolvePathByParentLookup(source, state, path);
  if (!resolved.found || resolved.node === null || resolved.node.state.kind === "directory") {
    return null;
  }
  return {
    path,
    node: resolved.node as LeafWorkdirNode,
  };
}

/**
 * 解析 `rename` / `copy` 这类“已存在源 -> 目标路径”的双路径上下文。
 *
 * @example
 * ```ts
 * const transfer = resolveWriteTransfer(source, state, "a.txt", "b.txt");
 * expect(transfer.from.existing.child.name).toBe("a.txt");
 * expect(transfer.to.name).toBe("b.txt");
 * ```
 */
export function resolveWriteTransfer(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  from: string,
  to: string,
): ResolvedWriteTransfer {
  assertValidVirtualPath(from);
  assertValidVirtualPath(to);
  return {
    from: requireExistingWriteTarget(source, state, from),
    to: resolveWriteTargetInParent(source, state, to),
  };
}

/**
 * 根据父节点与子条目名解析子节点
 */
export function resolveChild(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  parentNode: WorkdirNode,
  parentPath: string,
  name: string,
): { found: false; node: null } | { found: true; node: WorkdirNode } {
  const resolved = resolveDirectoryChild(source, state, parentNode, parentPath, name);
  if (!resolved.found) {
    return { found: false, node: null };
  }
  return { found: true, node: resolved.node };
}

/**
 * 根据父目录与子项名称定向解析当前可见子项及其节点。
 */
export function resolveDirectoryChild(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  parentNode: WorkdirNode,
  parentPath: string,
  name: string,
):
  | { found: false; child: null; node: null }
  | { found: true; child: MergedDirectoryChild; node: WorkdirNode } {
  if (parentNode.state.kind !== "directory") {
    return { found: false, child: null, node: null };
  }
  const child = getDirectoryChildrenView(source, state, parentNode, parentPath).get(name);
  if (child === undefined) {
    return { found: false, child: null, node: null };
  }
  const childNode = state.getNode(child.nodeId);
  if (childNode === null) {
    return { found: false, child: null, node: null };
  }
  return { found: true, child, node: childNode };
}

// ==================== 目录子项展开 ====================

/**
 * 获取目录当前视图，包含排序后的完整子项与按名查询能力。
 *
 * @example
 * ```ts
 * const view = getDirectoryChildrenView(source, state, dirNode, "");
 * expect(view.children.length).toBeGreaterThanOrEqual(0);
 * ```
 */
export function getDirectoryChildrenView(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  dirNode: WorkdirNode,
  dirPath: string,
): DirectoryChildrenView {
  const children = listDirectoryChildren(source, state, dirNode, dirPath);
  const childrenByName = new Map(children.map((child) => [child.name, child]));
  return {
    children,
    get(name) {
      return childrenByName.get(name);
    },
  };
}

/**
 * 以“先父目录、后最后一段”的方式解析路径。
 *
 * 适用于只关心最终条目的场景，便于复用目录级定向解析 helper。
 */
export function resolvePathByParentLookup(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  path: string,
): ResolveResult {
  const target = resolvePathParentLookupContext(source, state, path);
  if (target.parentNode === null) {
    return { found: false, node: null };
  }

  const resolved = resolveDirectoryChild(
    source,
    state,
    target.parentNode,
    target.parentPath,
    target.name,
  );
  if (!resolved.found) {
    return { found: false, node: null };
  }
  return { found: true, node: resolved.node };
}

/**
 * 确保 origin 条目对应的 workdir 节点已懒注册
 */
export function ensureNodeFromTreeEntry(state: VirtualWorkdirStateStore, entry: TreeEntry): NodeId {
  const id = originBackedNodeId(entry.hash);
  if (state.getNode(id) === null) {
    const origin = treeEntryToNodeOrigin(entry);
    let nodeState: WorkdirNode["state"];
    if (entry.mode === "040000") {
      nodeState = {
        kind: "directory",
        overlay: { addedEntries: new Map(), deletedNames: new Set() },
      };
    } else if (entry.mode === "120000") {
      nodeState = { kind: "symlink", mode: "120000" };
    } else {
      const mode: "100644" | "100755" = entry.mode === "100755" ? "100755" : "100644";
      nodeState = { kind: "file", mode };
    }
    state.setNode({ id, origin, state: nodeState });
  }
  return id;
}

/**
 * 展开目录的完整子项列表（origin + overlay 合成）
 */
export function listDirectoryChildren(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  dirNode: WorkdirNode,
  dirPath: string,
): MergedDirectoryChild[] {
  if (dirNode.state.kind !== "directory") {
    throw new VirtualNotDirectoryError(dirPath);
  }

  let originChildren: OriginDirectoryChild[] = [];
  if (dirNode.origin.kind === "repo-tree") {
    const tree = readRepoTree(source, dirNode.origin.hash, dirPath);
    originChildren = tree.entries.map((entry) => {
      const childNodeId = ensureNodeFromTreeEntry(state, entry);
      return { name: entry.name, mode: entry.mode, nodeId: childNodeId };
    });
  }

  const addedModes = buildAddedModes(state, dirNode);

  return mergeDirectoryChildren(originChildren, dirNode.state.overlay, addedModes);
}

/**
 * 构建 overlay addedEntries 对应的 mode map
 */
export function buildAddedModes(
  state: VirtualWorkdirStateStore,
  dirNode: WorkdirNode,
): ReadonlyMap<string, string> {
  if (dirNode.state.kind !== "directory") {
    return new Map();
  }
  const addedModes = new Map<string, string>();
  for (const name of dirNode.state.overlay.addedEntries.keys()) {
    const nodeId = dirNode.state.overlay.addedEntries.get(name)!;
    const node = state.getNode(nodeId);
    if (node !== null) {
      addedModes.set(name, workdirNodeMode(node));
    }
  }
  return addedModes;
}

// ==================== 辅助 ====================

function workdirNodeMode(node: WorkdirNode): string {
  if (node.state.kind === "directory") {
    return "040000";
  }
  if (node.state.kind === "symlink") {
    return "120000";
  }
  return node.state.mode;
}

function resolvePathParentLookupContext(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  path: string,
): ParentLookupContext {
  assertValidVirtualPath(path);
  const parent = parentPath(path);
  const name = baseName(path);
  const parentResolved =
    parent !== null
      ? resolvePath(source, state, parent)
      : { found: true, node: getRootNode(state) };

  return {
    parentPath: parent ?? VIRTUAL_ROOT_PATH,
    name,
    parentNode: parentResolved.found ? parentResolved.node : null,
  };
}
