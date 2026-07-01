/**
 * Virtual Worktree 路径解析与共享读视图
 *
 * 供 worktree.ts 与 write-tree.ts 复用：
 * - 路径解析（resolvePath / resolveWriteTarget*）
 * - 目录子项展开（listDirectoryChildren / getDirectoryChildrenView）
 * - origin 路径节点懒注册（ensureNodeFromTreeEntry）
 *
 * 目录观察与编译计划相关的类型和函数已拆分到 directory-view.ts。
 */

import {
  VirtualNotDirectoryError,
  VirtualNotFileError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
} from "../../errors.ts";
import { originPathNodeId, VIRTUAL_ROOT_NODE_ID } from "../model/ids.ts";
import { readRepoTree, treeEntryToNodeOrigin } from "../model/origin.ts";
import { mergeDirectoryChildren } from "../model/overlay.ts";
import {
  assertValidVirtualPath,
  baseName,
  joinPath,
  parentPath,
  splitPathSegments,
  VIRTUAL_ROOT_PATH,
} from "../model/path.ts";

import type { TreeEntry } from "../../types/index.ts";
import type { ObjectSource } from "../../types/odb.ts";
import type { NodeId } from "../model/ids.ts";
import type {
  DirectoryNodeState,
  FileNodeState,
  WorktreeNode,
  SymlinkNodeState,
} from "../model/nodes.ts";
import type { MergedDirectoryChild, OriginDirectoryChild } from "../model/overlay.ts";
import type { VirtualWorktreeStateStore } from "../store/state-store.ts";

type DirectoryWorktreeNode = WorktreeNode & { readonly state: DirectoryNodeState };
type LeafWorktreeNode = WorktreeNode & { readonly state: FileNodeState | SymlinkNodeState };

// ==================== 类型 ====================

export type ResolveResult =
  | { readonly found: false; readonly node: null }
  | { readonly found: true; readonly node: WorktreeNode };

export interface ResolvedDirectoryChild {
  readonly child: MergedDirectoryChild;
  readonly node: WorktreeNode;
}

export interface ResolvedLeafPath {
  readonly path: string;
  readonly node: LeafWorktreeNode;
}

export interface ResolvedWriteParentDirectory {
  readonly parentPath: string;
  readonly name: string;
  readonly parentNode: DirectoryWorktreeNode;
}

export interface ResolvedWriteTarget {
  readonly parentPath: string;
  readonly name: string;
  readonly parentNode: DirectoryWorktreeNode;
  readonly existing: ResolvedDirectoryChild | null;
}

export interface ResolvedExistingWriteTarget extends ResolvedWriteParentDirectory {
  readonly existing: ResolvedDirectoryChild;
}

export interface ResolvedLeafWriteTarget extends ResolvedWriteParentDirectory {
  readonly existing: {
    readonly child: MergedDirectoryChild;
    readonly node: LeafWorktreeNode;
  } | null;
}

export interface ResolvedWriteTransfer {
  readonly from: ResolvedExistingWriteTarget;
  readonly to: ResolvedWriteTarget;
}

interface ParentLookupContext {
  readonly parentPath: string;
  readonly name: string;
  readonly parentNode: WorktreeNode | null;
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

export function getRootNode(state: VirtualWorktreeStateStore): WorktreeNode {
  const root = state.getNode(VIRTUAL_ROOT_NODE_ID);
  if (root === null) {
    throw new Error("Virtual worktree is missing root node");
  }
  return root;
}

/**
 * 从根目录沿路径分段解析到目标节点
 */
export function resolvePath(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
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
  state: VirtualWorktreeStateStore,
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
    parentNode: target.parentNode as DirectoryWorktreeNode,
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
  state: VirtualWorktreeStateStore,
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
  state: VirtualWorktreeStateStore,
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
  state: VirtualWorktreeStateStore,
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
  state: VirtualWorktreeStateStore,
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
        : { child: target.existing.child, node: target.existing.node as LeafWorktreeNode },
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
  state: VirtualWorktreeStateStore,
  path: string,
): ResolvedLeafPath | null {
  const resolved = resolvePathByParentLookup(source, state, path);
  if (!resolved.found || resolved.node === null || resolved.node.state.kind === "directory") {
    return null;
  }
  return {
    path,
    node: resolved.node as LeafWorktreeNode,
  };
}

/**
 * 解析 `move` / `copy` 这类“已存在源 -> 目标路径”的双路径上下文。
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
  state: VirtualWorktreeStateStore,
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
  state: VirtualWorktreeStateStore,
  parentNode: WorktreeNode,
  parentPath: string,
  name: string,
): { found: false; node: null } | { found: true; node: WorktreeNode } {
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
  state: VirtualWorktreeStateStore,
  parentNode: WorktreeNode,
  parentPath: string,
  name: string,
):
  | { found: false; child: null; node: null }
  | { found: true; child: MergedDirectoryChild; node: WorktreeNode } {
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
  state: VirtualWorktreeStateStore,
  dirNode: WorktreeNode,
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
  state: VirtualWorktreeStateStore,
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

export function ensureNodeFromTreeEntry(
  state: VirtualWorktreeStateStore,
  path: string,
  entry: TreeEntry,
): NodeId {
  const id = originPathNodeId(path);
  if (state.getNode(id) === null) {
    const origin = treeEntryToNodeOrigin(entry);
    let nodeState: WorktreeNode["state"];
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
  state: VirtualWorktreeStateStore,
  dirNode: WorktreeNode,
  dirPath: string,
): MergedDirectoryChild[] {
  if (dirNode.state.kind !== "directory") {
    throw new VirtualNotDirectoryError(dirPath);
  }

  let originChildren: OriginDirectoryChild[] = [];
  if (dirNode.origin.kind === "repo-tree") {
    const tree = readRepoTree(source, dirNode.origin.hash, dirPath);
    originChildren = tree.entries.map((entry) => {
      const childPath = joinChildPath(dirPath, entry.name);
      const childNodeId = ensureNodeFromTreeEntry(state, childPath, entry);
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
  state: VirtualWorktreeStateStore,
  dirNode: WorktreeNode,
): ReadonlyMap<string, string> {
  if (dirNode.state.kind !== "directory") {
    return new Map();
  }
  const addedModes = new Map<string, string>();
  for (const name of dirNode.state.overlay.addedEntries.keys()) {
    const nodeId = dirNode.state.overlay.addedEntries.get(name)!;
    const node = state.getNode(nodeId);
    if (node !== null) {
      addedModes.set(name, worktreeNodeMode(node));
    }
  }
  return addedModes;
}

// ==================== 辅助 ====================

function worktreeNodeMode(node: WorktreeNode): string {
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
  state: VirtualWorktreeStateStore,
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
