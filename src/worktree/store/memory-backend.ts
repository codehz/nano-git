/**
 * Virtual Worktree 内存状态存储
 */

import { VIRTUAL_ROOT_NODE_ID, type NodeId } from "../model/ids.ts";
import { createRootDirectoryNode, type WorktreeNode } from "../model/nodes.ts";

import type { SHA1 } from "../../types/index.ts";
import type { NormalizedChangeRecord } from "../engine/change-index.ts";
import type { VirtualWorktreeStateStore } from "./state-store.ts";

/**
 * 单个 worktree 实例的可变内存状态
 */
interface VirtualWorktreeMemoryState {
  /** 当前基线 tree */
  baseTree: SHA1;
  /** nodeId -> 节点记录 */
  readonly nodes: Map<NodeId, WorktreeNode>;
  /** path -> 规范化变更记录 */
  readonly changeRecords: Map<string, NormalizedChangeRecord>;
}

/**
 * 创建内存版状态存储
 *
 * @param baseTree - 初始基线 tree 哈希
 * @returns 进程内可变状态存储（包内使用，对外请用 `createVirtualWorktree`）
 *
 * @example
 * ```ts
 * const store = createVirtualWorktreeMemoryStateStore(tree);
 * expect(store.readBaseTree()).toBe(tree);
 * ```
 */
export function createVirtualWorktreeMemoryStateStore(baseTree: SHA1): VirtualWorktreeStateStore {
  const state: VirtualWorktreeMemoryState = {
    baseTree,
    nodes: new Map<NodeId, WorktreeNode>(),
    changeRecords: new Map<string, NormalizedChangeRecord>(),
  };

  resetState(state, baseTree);

  return {
    kind: "memory",

    transact<T>(fn: () => T): T {
      const snapshot = snapshotState(state);
      try {
        return fn();
      } catch (error) {
        restoreState(state, snapshot);
        throw error;
      }
    },

    readBaseTree(): SHA1 {
      return state.baseTree;
    },

    writeBaseTree(nextBaseTree: SHA1): void {
      state.baseTree = nextBaseTree;
    },

    getNode(id: NodeId): WorktreeNode | null {
      return state.nodes.get(id) ?? null;
    },

    setNode(node: WorktreeNode): void {
      state.nodes.set(node.id, node);
    },

    deleteNode(id: NodeId): void {
      state.nodes.delete(id);
    },

    listChangeRecords(): readonly NormalizedChangeRecord[] {
      return Array.from(state.changeRecords.values()).sort((left, right) =>
        left.path.localeCompare(right.path),
      );
    },

    getChangeRecord(path: string): NormalizedChangeRecord | null {
      return state.changeRecords.get(path) ?? null;
    },

    setChangeRecord(record: NormalizedChangeRecord): void {
      state.changeRecords.set(record.path, record);
    },

    deleteChangeRecord(path: string): void {
      state.changeRecords.delete(path);
    },

    reset(nextBaseTree: SHA1): void {
      resetState(state, nextBaseTree);
    },
  };
}

function resetState(state: VirtualWorktreeMemoryState, baseTree: SHA1): void {
  state.baseTree = baseTree;
  state.nodes.clear();
  state.changeRecords.clear();
  state.nodes.set(VIRTUAL_ROOT_NODE_ID, createRootDirectoryNode(baseTree));
}

interface VirtualWorktreeMemoryStateSnapshot {
  readonly baseTree: SHA1;
  readonly nodes: ReadonlyMap<NodeId, WorktreeNode>;
  readonly changeRecords: ReadonlyMap<string, NormalizedChangeRecord>;
}

function snapshotState(state: VirtualWorktreeMemoryState): VirtualWorktreeMemoryStateSnapshot {
  const nodes = new Map<NodeId, WorktreeNode>();
  for (const [nodeId, node] of state.nodes) {
    nodes.set(nodeId, cloneWorktreeNode(node));
  }
  return {
    baseTree: state.baseTree,
    nodes,
    changeRecords: new Map(state.changeRecords),
  };
}

function restoreState(
  state: VirtualWorktreeMemoryState,
  snapshot: VirtualWorktreeMemoryStateSnapshot,
): void {
  state.baseTree = snapshot.baseTree;
  state.nodes.clear();
  state.changeRecords.clear();
  for (const [nodeId, node] of snapshot.nodes) {
    state.nodes.set(nodeId, cloneWorktreeNode(node));
  }
  for (const [path, record] of snapshot.changeRecords) {
    state.changeRecords.set(path, record);
  }
}

function cloneWorktreeNode(node: WorktreeNode): WorktreeNode {
  if (node.state.kind === "directory") {
    return {
      id: node.id,
      origin: node.origin,
      state: {
        kind: "directory",
        overlay: {
          addedEntries: new Map(node.state.overlay.addedEntries),
          deletedNames: new Set(node.state.overlay.deletedNames),
        },
      },
    };
  }

  if (node.state.kind === "file") {
    return {
      id: node.id,
      origin: node.origin,
      state:
        node.state.content === undefined
          ? { kind: "file", mode: node.state.mode }
          : { kind: "file", mode: node.state.mode, content: Buffer.from(node.state.content) },
    };
  }

  return {
    id: node.id,
    origin: node.origin,
    state:
      node.state.target === undefined
        ? { kind: "symlink", mode: "120000" }
        : { kind: "symlink", mode: "120000", target: Buffer.from(node.state.target) },
  };
}
