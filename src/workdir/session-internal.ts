/**
 * Virtual Workdir session 内部共享逻辑
 *
 * 供 session.ts 与 write-tree.ts 复用：
 * - 路径解析（resolvePath）
 * - 目录子项展开（listDirectoryChildren）
 * - origin 节点懒注册（ensureNodeFromTreeEntry）
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
import type { DirectoryNodeState, FileNodeState, SessionNode, SymlinkNodeState } from "./nodes.ts";
import type { MergedDirectoryChild, OriginDirectoryChild } from "./overlay.ts";
import type { VirtualWorkdirStateStore } from "./state-store.ts";

type DirectorySessionNode = SessionNode & { readonly state: DirectoryNodeState };
type LeafSessionNode = SessionNode & { readonly state: FileNodeState | SymlinkNodeState };

// ==================== 路径解析 ====================

export type ResolveResult =
  | { readonly found: false; readonly node: null }
  | { readonly found: true; readonly node: SessionNode };

/**
 * 目录 origin 子项按名查询视图
 */
export interface NamedOriginChildLookup {
  /** 按 Git tree 原始顺序返回 origin 条目 */
  readonly entries: readonly TreeEntry[];
  /** 判断某名称是否存在 origin 条目 */
  has(name: string): boolean;
  /** 按名称读取 origin 条目 */
  get(name: string): TreeEntry | undefined;
}

/**
 * 按受影响名字筛选后的目录子项编译计划
 */
export interface AffectedDirectoryChildPlanEntry {
  /** 子项名称 */
  readonly name: string;
  /** origin 中的原始条目；纯新增时为 null */
  readonly originEntry: TreeEntry | null;
  /** 是否需要进入编译路径 */
  readonly shouldCompile: boolean;
}

/**
 * 目录观察结果
 */
export interface ObservedDirectoryChildren {
  /** 当前目录下受影响的直接子项名 */
  readonly affectedNames: ReadonlySet<string>;
  /** 当前目录更深层累计脏项数 */
  readonly dirtyDescendantCount: number;
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

/**
 * 按名称解析到的目录子项
 */
export interface ResolvedDirectoryChild {
  readonly child: MergedDirectoryChild;
  readonly node: SessionNode;
}

/**
 * 按路径解析到的当前叶子节点
 */
export interface ResolvedLeafPath {
  /** 路径本身 */
  readonly path: string;
  /** 当前叶子节点 */
  readonly node: LeafSessionNode;
}

/**
 * 已展开目录子项对应的当前节点与路径
 */
export interface ObservedDirectoryChildNode {
  /** 子项名称 */
  readonly name: string;
  /** 子项完整路径 */
  readonly path: string;
  /** 原始目录子项 */
  readonly child: MergedDirectoryChild;
  /** 当前节点 */
  readonly node: SessionNode;
}

/**
 * 写路径父目录解析结果
 */
export interface ResolvedWriteParentDirectory {
  /** 目标父目录路径，根目录时为空字符串 */
  readonly parentPath: string;
  /** 目标在父目录下的名字 */
  readonly name: string;
  /** 已确认可写的父目录节点 */
  readonly parentNode: DirectorySessionNode;
}

/**
 * 写路径目标解析结果
 */
export interface ResolvedWriteTarget {
  /** 目标父目录路径，根目录时为空字符串 */
  readonly parentPath: string;
  /** 目标在父目录下的名字 */
  readonly name: string;
  /** 已确认可写的父目录节点 */
  readonly parentNode: DirectorySessionNode;
  /** 当前已存在的可见子项；不存在时为 null */
  readonly existing: ResolvedDirectoryChild | null;
}

/**
 * 已确认存在的写路径目标
 */
export interface ResolvedExistingWriteTarget extends ResolvedWriteParentDirectory {
  /** 当前已存在的可见子项 */
  readonly existing: ResolvedDirectoryChild;
}

/**
 * 允许写入 blob/symlink 的目标
 */
export interface ResolvedLeafWriteTarget extends ResolvedWriteParentDirectory {
  /** 当前已存在的可见叶子子项；不存在时为 null */
  readonly existing: {
    readonly child: MergedDirectoryChild;
    readonly node: LeafSessionNode;
  } | null;
}

/**
 * 双路径写操作上下文
 */
export interface ResolvedWriteTransfer {
  /** 已确认存在的源路径上下文 */
  readonly from: ResolvedExistingWriteTarget;
  /** 目标路径上下文 */
  readonly to: ResolvedWriteTarget;
}

/**
 * 按父目录解析路径后的公共上下文
 */
export interface ParentLookupContext {
  /** 目标父目录路径，根目录时为空字符串 */
  readonly parentPath: string;
  /** 目标在父目录下的名字 */
  readonly name: string;
  /** 已解析出的父节点；不存在时为 null */
  readonly parentNode: SessionNode | null;
}

/**
 * 基于目录路径与子项名称拼出子路径。
 *
 * 根目录使用空字符串表示，因此根下子项直接返回名称本身。
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

/**
 * 基于已展开的目录子项读取当前节点与完整路径。
 *
 * 节点不存在时返回 `null`。
 *
 * @example
 * ```ts
 * const observed = observeListedDirectoryChild(state, "", child);
 * expect(observed?.path).toBe("a.txt");
 * ```
 */
export function observeListedDirectoryChild(
  state: VirtualWorkdirStateStore,
  dirPath: string,
  child: MergedDirectoryChild,
): ObservedDirectoryChildNode | null {
  const node = state.getNode(child.nodeId);
  if (node === null) {
    return null;
  }
  return {
    name: child.name,
    path: joinChildPath(dirPath, child.name),
    child,
    node,
  };
}

/**
 * 基于目录节点与子项名称定向读取当前节点与完整路径。
 *
 * 适用于已持有 origin lookup、但不想手工重复拼装 `{ name, path, node }`
 * 局部协议的场景。
 *
 * @example
 * ```ts
 * const observed = observeNamedDirectoryChild(state, dirNode, "", lookup, "a.txt");
 * expect(observed?.path).toBe("a.txt");
 * ```
 */
export function observeNamedDirectoryChild(
  state: VirtualWorkdirStateStore,
  dirNode: SessionNode,
  dirPath: string,
  originLookup: NamedOriginChildLookup,
  name: string,
): Pick<ObservedDirectoryChildNode, "name" | "path" | "node"> | null {
  if (dirNode.state.kind !== "directory") {
    return null;
  }
  const resolved = resolveNamedChild(state, dirNode, originLookup, name);
  if (!resolved.found) {
    return null;
  }
  return {
    name,
    path: joinChildPath(dirPath, name),
    node: resolved.node,
  };
}

export function getRootNode(state: VirtualWorkdirStateStore): SessionNode {
  const root = state.getNode(VIRTUAL_ROOT_NODE_ID);
  if (root === null) {
    throw new Error("Virtual workdir session is missing root node");
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
    parentNode: target.parentNode as DirectorySessionNode,
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
        : { child: target.existing.child, node: target.existing.node as LeafSessionNode },
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
    node: resolved.node as LeafSessionNode,
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
  parentNode: SessionNode,
  parentPath: string,
  name: string,
): { found: false; node: null } | { found: true; node: SessionNode } {
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
  parentNode: SessionNode,
  parentPath: string,
  name: string,
):
  | { found: false; child: null; node: null }
  | { found: true; child: MergedDirectoryChild; node: SessionNode } {
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

/**
 * 在不展开整个目录列表的前提下，按名称定向解析单个子节点。
 *
 * 优先读取 overlay 绑定；若 overlay 未覆盖，再按需从 origin 条目懒注册。
 *
 * @example
 * ```ts
 * const resolved = resolveNamedChild(
 *   state,
 *   dirNode,
 *   originLookup,
 *   "a.txt",
 * );
 * expect(resolved.found).toBe(true);
 * ```
 */
export function resolveNamedChild(
  state: VirtualWorkdirStateStore,
  dirNode: SessionNode,
  originLookup: NamedOriginChildLookup,
  name: string,
): { found: false; node: null } | { found: true; node: SessionNode } {
  if (dirNode.state.kind !== "directory") {
    return { found: false, node: null };
  }

  const overlayNodeId = dirNode.state.overlay.addedEntries.get(name);
  if (overlayNodeId !== undefined) {
    const overlayNode = state.getNode(overlayNodeId);
    return overlayNode === null ? { found: false, node: null } : { found: true, node: overlayNode };
  }
  if (dirNode.state.overlay.deletedNames.has(name)) {
    return { found: false, node: null };
  }

  const originEntry = originLookup.get(name);
  if (originEntry === undefined) {
    return { found: false, node: null };
  }
  const originNodeId = ensureNodeFromTreeEntry(state, originEntry);
  const originNode = state.getNode(originNodeId);
  return originNode === null ? { found: false, node: null } : { found: true, node: originNode };
}

/**
 * 为目录 origin 条目创建按名查询视图。
 *
 * @example
 * ```ts
 * const lookup = createNamedOriginChildLookup(tree.entries);
 * expect(lookup.has("a.txt")).toBe(true);
 * ```
 */
export function createNamedOriginChildLookup(
  entries: readonly TreeEntry[],
): NamedOriginChildLookup {
  const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
  return {
    entries,
    has(name) {
      return entriesByName.has(name);
    },
    get(name) {
      return entriesByName.get(name);
    },
  };
}

/**
 * 基于 origin 顺序和受影响名字生成目录子项编译计划。
 *
 * 1. origin 中未受影响的条目保持原顺序并标记为直接复用
 * 2. origin 中受影响的条目保持原顺序并标记为需要编译
 * 3. 不在 origin 中的受影响名字补在末尾
 *
 * @example
 * ```ts
 * const plan = planAffectedDirectoryChildren(lookup, new Set(["b.txt", "c.txt"]));
 * expect(plan.map((entry) => entry.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
 * ```
 */
export function planAffectedDirectoryChildren(
  originLookup: NamedOriginChildLookup,
  affectedNames: ReadonlySet<string>,
): readonly AffectedDirectoryChildPlanEntry[] {
  const out: AffectedDirectoryChildPlanEntry[] = [];

  for (const entry of originLookup.entries) {
    out.push({
      name: entry.name,
      originEntry: entry,
      shouldCompile: affectedNames.has(entry.name),
    });
  }

  for (const name of affectedNames) {
    if (originLookup.has(name)) {
      continue;
    }
    out.push({
      name,
      originEntry: null,
      shouldCompile: true,
    });
  }

  return out;
}

/**
 * 观察目录当前子项，归纳直接受影响名字与更深层脏项数。
 *
 * 目录自身 overlay 的 add/delete 会直接计入 `affectedNames`；
 * 子目录是否脏、叶子节点是否脏由调用方回调决定。
 *
 * @example
 * ```ts
 * const observed = observeDirectoryChildren(source, state, node, "", {
 *   onDirectoryChild() {
 *     return 0;
 *   },
 *   isLeafChildDirty() {
 *     return false;
 *   },
 * });
 * expect(observed.affectedNames.size).toBeGreaterThanOrEqual(0);
 * ```
 */
export function observeDirectoryChildren(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  dirNode: SessionNode,
  dirPath: string,
  options: {
    onDirectoryChild(child: {
      readonly name: string;
      readonly path: string;
      readonly node: SessionNode;
    }): number;
    isLeafChildDirty(child: {
      readonly name: string;
      readonly path: string;
      readonly node: SessionNode;
    }): boolean;
  },
): ObservedDirectoryChildren {
  if (dirNode.state.kind !== "directory") {
    throw new VirtualNotDirectoryError(dirPath);
  }

  const affectedNames = new Set<string>([
    ...dirNode.state.overlay.addedEntries.keys(),
    ...dirNode.state.overlay.deletedNames.values(),
  ]);
  let dirtyDescendantCount = 0;
  const children = listDirectoryChildren(source, state, dirNode, dirPath);

  for (const child of children) {
    const observedChild = observeListedDirectoryChild(state, dirPath, child);
    if (observedChild === null) {
      continue;
    }

    if (observedChild.node.state.kind === "directory") {
      const childDirtyCount = options.onDirectoryChild({
        name: observedChild.name,
        path: observedChild.path,
        node: observedChild.node,
      });
      if (childDirtyCount > 0) {
        affectedNames.add(observedChild.name);
        dirtyDescendantCount += childDirtyCount;
      }
      continue;
    }

    if (
      options.isLeafChildDirty({
        name: observedChild.name,
        path: observedChild.path,
        node: observedChild.node,
      })
    ) {
      affectedNames.add(observedChild.name);
    }
  }

  return { affectedNames, dirtyDescendantCount };
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
  dirNode: SessionNode,
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
 * 确保 origin 条目对应的 session 节点已懒注册
 */
export function ensureNodeFromTreeEntry(state: VirtualWorkdirStateStore, entry: TreeEntry): NodeId {
  const id = originBackedNodeId(entry.hash);
  if (state.getNode(id) === null) {
    const origin = treeEntryToNodeOrigin(entry);
    let nodeState: SessionNode["state"];
    if (entry.mode === "40000") {
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
  dirNode: SessionNode,
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
  dirNode: SessionNode,
): ReadonlyMap<string, string> {
  if (dirNode.state.kind !== "directory") {
    return new Map();
  }
  const addedModes = new Map<string, string>();
  for (const name of dirNode.state.overlay.addedEntries.keys()) {
    const nodeId = dirNode.state.overlay.addedEntries.get(name)!;
    const node = state.getNode(nodeId);
    if (node !== null) {
      addedModes.set(name, sessionNodeMode(node));
    }
  }
  return addedModes;
}

// ==================== 辅助 ====================

function sessionNodeMode(node: SessionNode): string {
  if (node.state.kind === "directory") {
    return "40000";
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
