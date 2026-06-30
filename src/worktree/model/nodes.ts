/**
 * Virtual Worktree 节点状态模型
 *
 * `NodeId` 表示 worktree 中的可变节点身份；
 * `origin.hash` 表示 Git 对象数据库里的不可变内容身份。
 *
 * 两者必须分离：
 * - 多个路径可以共享同一个 origin hash
 * - 但这些路径在 worktree 中必须拥有各自独立的 NodeId
 *
 * 否则单路径写入、copy 等操作会错误串改兄弟路径。
 */

import { VIRTUAL_ROOT_NODE_ID, type NodeId } from "./ids.ts";
import {
  createEmptyDirectoryOverlay,
  cloneDirectoryOverlay,
  type DirectoryOverlay,
} from "./overlay.ts";

import type { SHA1 } from "../../core/types.ts";

export type { NodeId } from "./ids.ts";
export { createNodeId, resetNodeIdCounterForTests, VIRTUAL_ROOT_NODE_ID } from "./ids.ts";

/** Blob / 符号链接在 origin 与 state 中使用的 mode */
export type BlobObjectMode = "100644" | "100755" | "120000";

// ==================== Origin ====================

/**
 * 节点来源（repo 对象或纯 worktree 新建）
 *
 * 注意：这里记录的是“内容来源”而不是“节点身份来源”。
 */
export type NodeOrigin =
  | { readonly kind: "none" }
  | { readonly kind: "repo-tree"; readonly hash: SHA1 }
  | { readonly kind: "repo-blob"; readonly mode: BlobObjectMode; readonly hash: SHA1 };

// ==================== 节点状态 ====================

/**
 * 目录节点当前状态
 *
 * `overlay` 表达 worktree 层增删改；子项 nodeId 通过 overlay 合成与懒加载解析。
 */
export interface DirectoryNodeState {
  readonly kind: "directory";
  readonly overlay: DirectoryOverlay;
}

/**
 * 文件节点当前状态（raw content overlay）
 */
export interface FileNodeState {
  readonly kind: "file";
  readonly mode: "100644" | "100755";
  /** 未设置时表示未 materialize，可读 origin */
  readonly content?: Buffer;
}

/**
 * 符号链接节点当前状态
 */
export interface SymlinkNodeState {
  readonly kind: "symlink";
  readonly mode: "120000";
  readonly target?: Buffer;
}

export type WorktreeNodeState = DirectoryNodeState | FileNodeState | SymlinkNodeState;

/**
 * 完整的 worktree 节点记录
 */
export interface WorktreeNode {
  readonly id: NodeId;
  readonly origin: NodeOrigin;
  readonly state: WorktreeNodeState;
}

// ==================== 工厂与变换 ====================

/**
 * 创建绑定 repo 根 tree 的目录节点（带空 overlay）
 */
export function createRootDirectoryNode(originTreeHash: SHA1): WorktreeNode {
  return {
    id: VIRTUAL_ROOT_NODE_ID,
    origin: { kind: "repo-tree", hash: originTreeHash },
    state: { kind: "directory", overlay: createEmptyDirectoryOverlay() },
  };
}

/**
 * 创建纯 worktree 新建、无 origin 的目录节点
 */
export function createNewDirectoryNode(id: NodeId): WorktreeNode {
  return {
    id,
    origin: { kind: "none" },
    state: { kind: "directory", overlay: createEmptyDirectoryOverlay() },
  };
}

/**
 * 文件/符号链接是否已 materialize（存在 overlay 内容）
 */
export function isBlobStateMaterialized(state: FileNodeState | SymlinkNodeState): boolean {
  if (state.kind === "file") {
    return state.content !== undefined;
  }
  return state.target !== undefined;
}

/**
 * 目录 overlay 是否有 worktree 层修改
 */
export function isDirectoryOverlayDirty(overlay: DirectoryOverlay): boolean {
  return overlay.addedEntries.size > 0 || overlay.deletedNames.size > 0;
}

/**
 * 节点是否存在 worktree 层 CoW 修改
 */
export function isNodeDirty(node: WorktreeNode): boolean {
  if (node.state.kind === "directory") {
    return isDirectoryOverlayDirty(node.state.overlay);
  }
  if (node.state.kind === "file" || node.state.kind === "symlink") {
    return isBlobStateMaterialized(node.state);
  }
  return false;
}

/**
 * 为 `copy` 创建新节点：共享 origin，目录采用 CoW（写时复制）
 * （子项绑定保留，但 nodeId 为新；实际子树只在任一副本写入时分裂）
 */
export function cloneWorktreeNodeForCopy(source: WorktreeNode, newId: NodeId): WorktreeNode {
  const origin = source.origin;

  if (source.state.kind === "directory") {
    return {
      id: newId,
      origin,
      state: {
        kind: "directory",
        overlay: cloneDirectoryOverlay(source.state.overlay),
      },
    };
  }

  if (source.state.kind === "file") {
    const content = source.state.content;
    return {
      id: newId,
      origin,
      state:
        content === undefined
          ? { kind: "file", mode: source.state.mode }
          : { kind: "file", mode: source.state.mode, content: Buffer.from(content) },
    };
  }

  const target = source.state.target;
  return {
    id: newId,
    origin,
    state:
      target === undefined
        ? { kind: "symlink", mode: "120000" }
        : { kind: "symlink", mode: "120000", target: Buffer.from(target) },
  };
}
