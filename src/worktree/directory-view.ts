/**
 * Virtual Worktree 目录展开、观察与编译计划
 *
 * 从 worktree-path.ts 拆分，聚焦以下职责：
 * - 目录子项观察（observeDirectoryChildren / observeListedDirectoryChild / observeNamedDirectoryChild）
 * - origin 按名查询视图（createNamedOriginChildLookup）
 * - 受影响子项编译计划（planAffectedDirectoryChildren）
 */

import { VirtualNotDirectoryError } from "../core/errors.ts";
import { ensureNodeFromTreeEntry, joinChildPath, listDirectoryChildren } from "./worktree-path.ts";

import type { TreeEntry } from "../core/types.ts";
import type { ObjectSource } from "../core/types/odb.ts";
import type { WorktreeNode } from "./nodes.ts";
import type { MergedDirectoryChild } from "./overlay.ts";
import type { VirtualWorktreeStateStore } from "./state-store.ts";

// ==================== 类型 ====================

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
  readonly node: WorktreeNode;
}

// ==================== 定向节点解析 ====================

/**
 * 在不展开整个目录列表的前提下，按名称定向解析单个子节点。
 *
 * 优先读取 overlay 绑定；若 overlay 未覆盖，再按需从 origin 条目懒注册。
 */
export function resolveNamedChild(
  state: VirtualWorktreeStateStore,
  dirNode: WorktreeNode,
  dirPath: string,
  originLookup: NamedOriginChildLookup,
  name: string,
): { found: false; node: null } | { found: true; node: WorktreeNode } {
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
  const originNodeId = ensureNodeFromTreeEntry(state, joinChildPath(dirPath, name), originEntry);
  const originNode = state.getNode(originNodeId);
  return originNode === null ? { found: false, node: null } : { found: true, node: originNode };
}

// ==================== 目录子项观察 ====================

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
  state: VirtualWorktreeStateStore,
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
  state: VirtualWorktreeStateStore,
  dirNode: WorktreeNode,
  dirPath: string,
  originLookup: NamedOriginChildLookup,
  name: string,
): Pick<ObservedDirectoryChildNode, "name" | "path" | "node"> | null {
  if (dirNode.state.kind !== "directory") {
    return null;
  }
  const resolved = resolveNamedChild(state, dirNode, dirPath, originLookup, name);
  if (!resolved.found) {
    return null;
  }
  return {
    name,
    path: joinChildPath(dirPath, name),
    node: resolved.node,
  };
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
  state: VirtualWorktreeStateStore,
  dirNode: WorktreeNode,
  dirPath: string,
  options: {
    onDirectoryChild(child: {
      readonly name: string;
      readonly path: string;
      readonly node: WorktreeNode;
    }): number;
    isLeafChildDirty(child: {
      readonly name: string;
      readonly path: string;
      readonly node: WorktreeNode;
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

// ==================== Origin 查询与编译计划 ====================

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
