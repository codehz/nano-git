/**
 * Virtual Worktree 写事务与节点辅助函数
 *
 * 从 worktree.ts 提取，降低编排层复杂度：
 * - 写操作事务生命周期管理
 * - 父目录 overlay 更新
 * - 节点状态统计（stat）
 * - 递归节点图克隆（copy）
 */

import { createNodeId } from "../model/ids.ts";
import { cloneWorktreeNodeForCopy, type WorktreeNode } from "../model/nodes.ts";
import { readRepoBlobContent } from "../model/origin.ts";
import { overlayBindEntry, type DirectoryOverlay } from "../model/overlay.ts";
import { observeListedDirectoryChild } from "./directory-view.ts";
import { listDirectoryChildren } from "./worktree-path.ts";

import type { ObjectDatabase } from "../../types/odb.ts";
import type { VirtualEntryStat } from "../core.ts";
import type { NodeId } from "../model/ids.ts";
import type { VirtualWorktreeStateStore } from "../store/state-store.ts";

/**
 * 在 state store 事务边界内执行写操作。
 *
 * @param state - worktree 内部状态存储
 * @param onBeforeCommit - 提交前回调（在事务 callback 内执行）；可为 null
 * @param onCommitted - 提交后回调（在事务 callback 外执行）
 * @param fn - 实际写入逻辑
 */
export function runInWriteTransaction<T>(
  state: VirtualWorktreeStateStore,
  onBeforeCommit: (() => void) | null,
  onCommitted: () => void,
  fn: () => T,
): T {
  const result =
    onBeforeCommit === null
      ? state.transact(fn)
      : state.transact(() => {
          const innerResult = fn();
          onBeforeCommit();
          return innerResult;
        });
  onCommitted();
  return result;
}

/**
 * 更新父节点的 overlay（创建新节点对象替代 Map 中的旧引用）
 */
export function updateParentOverlay(
  state: VirtualWorktreeStateStore,
  parentId: NodeId,
  newOverlay: DirectoryOverlay,
): void {
  const parentNode = state.getNode(parentId);
  if (parentNode === null || parentNode.state.kind !== "directory") {
    throw new Error("updateParentOverlay: parent is not a directory");
  }
  state.setNode({
    ...parentNode,
    state: { ...parentNode.state, overlay: newOverlay },
  });
}

/**
 * 获取节点统计信息（用于 worktree.stat() 实现）
 */
export function statNode(
  source: ObjectDatabase,
  node: WorktreeNode,
  path: string,
): VirtualEntryStat {
  if (node.state.kind === "directory") {
    return statDirectoryNode(node);
  }
  if (node.state.kind === "symlink") {
    const hash = node.origin.kind === "repo-blob" ? node.origin.hash : null;
    let size = 0;
    if (node.state.target !== undefined) {
      size = node.state.target.length;
    } else if (hash !== null) {
      size = readRepoBlobContent(source, hash, path).length;
    }
    return { kind: "symlink", mode: "120000", size, hash };
  }
  const hash = node.origin.kind === "repo-blob" ? node.origin.hash : null;
  let size = 0;
  if (node.state.content !== undefined) {
    size = node.state.content.length;
  } else if (hash !== null) {
    size = readRepoBlobContent(source, hash, path).length;
  }
  return { kind: "blob", mode: node.state.mode, size, hash };
}

/**
 * 目录节点统计信息（无大小，hash 取 origin）
 */
export function statDirectoryNode(node: WorktreeNode): VirtualEntryStat {
  const hash = node.origin.kind === "repo-tree" ? node.origin.hash : null;
  return { kind: "tree", mode: "040000", size: 0, hash };
}

/**
 * 递归克隆节点图（用于 copy 语义）。
 *
 * 为新节点分配新身份，避免 copy 后源与目标共享子节点身份。
 */
export function cloneNodeGraphForCopy(
  source: ObjectDatabase,
  state: VirtualWorktreeStateStore,
  node: WorktreeNode,
  path: string,
): NodeId {
  const newNodeId = createNodeId();
  const cloned = cloneWorktreeNodeForCopy(node, newNodeId);
  state.setNode(cloned);

  if (node.state.kind !== "directory" || cloned.state.kind !== "directory") {
    return newNodeId;
  }

  let overlay = cloned.state.overlay;
  const children = listDirectoryChildren(source, state, node, path);
  for (const child of children) {
    const observedChild = observeListedDirectoryChild(state, path, child);
    if (observedChild === null) {
      continue;
    }
    const clonedChildId = cloneNodeGraphForCopy(
      source,
      state,
      observedChild.node,
      observedChild.path,
    );
    overlay = overlayBindEntry(overlay, observedChild.name, clonedChildId);
  }

  state.setNode({
    ...cloned,
    state: { kind: "directory", overlay },
  });
  return newNodeId;
}
