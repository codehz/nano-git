/**
 * Virtual Workdir 内存状态存储
 */

import {
  createVirtualChangeLog,
  type InternalChangeRecord,
  type VirtualChangeLog,
} from "./change-log.ts";
import { VIRTUAL_ROOT_NODE_ID, type NodeId } from "./ids.ts";
import { createRootDirectoryNode, type SessionNode } from "./nodes.ts";
import { createVirtualWorkdirSessionId } from "./session-id.ts";
import { openVirtualWorkdirSession } from "./session.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectDatabase } from "../core/types/odb.ts";
import type {
  CreateVirtualWorkdirSessionOptions,
  VirtualWorkdirBackend,
  VirtualWorkdirSession,
  VirtualWorkdirSessionId,
} from "./core.ts";
import type { VirtualWorkdirStateStore } from "./state-store.ts";

/**
 * 单个 session 的可变内存状态
 */
interface VirtualWorkdirMemoryState {
  /** 当前基线 tree */
  baseTree: SHA1;
  /** nodeId -> 节点记录 */
  readonly nodes: Map<NodeId, SessionNode>;
  /** 变更日志 */
  readonly changeLog: VirtualChangeLog;
}

/**
 * 创建内存版状态存储
 *
 * @example
 * ```ts
 * const store = createVirtualWorkdirMemoryStateStore(tree);
 * expect(store.readBaseTree()).toBe(tree);
 * ```
 */
export function createVirtualWorkdirMemoryStateStore(baseTree: SHA1): VirtualWorkdirStateStore {
  const state: VirtualWorkdirMemoryState = {
    baseTree,
    nodes: new Map<NodeId, SessionNode>(),
    changeLog: createVirtualChangeLog(),
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

    getNode(id: NodeId): SessionNode | null {
      return state.nodes.get(id) ?? null;
    },

    setNode(node: SessionNode): void {
      state.nodes.set(node.id, node);
    },

    deleteNode(id: NodeId): void {
      state.nodes.delete(id);
    },

    appendChange(record: InternalChangeRecord): void {
      state.changeLog.append(record);
    },

    listChangeRecords(): readonly InternalChangeRecord[] {
      return state.changeLog.snapshot();
    },

    clearChanges(): void {
      state.changeLog.clear();
    },

    reset(nextBaseTree: SHA1): void {
      resetState(state, nextBaseTree);
    },
  };
}

/**
 * 创建内存版 Virtual Workdir backend
 *
 * @example
 * ```ts
 * const backend = createMemoryVirtualWorkdirBackend();
 * const sessionId = backend.createSession({ baseTree: tree });
 * const session = backend.openSession(repo.objects, sessionId);
 * expect(session.baseTree).toBe(tree);
 * ```
 */
export function createMemoryVirtualWorkdirBackend(): VirtualWorkdirBackend {
  const sessions = new Map<VirtualWorkdirSessionId, VirtualWorkdirStateStore>();

  return {
    kind: "memory",

    createSession(options: CreateVirtualWorkdirSessionOptions): VirtualWorkdirSessionId {
      const sessionId = createVirtualWorkdirSessionId();
      sessions.set(sessionId, createVirtualWorkdirMemoryStateStore(options.baseTree));
      return sessionId;
    },

    openSession(source: ObjectDatabase, sessionId: VirtualWorkdirSessionId): VirtualWorkdirSession {
      const store = sessions.get(sessionId);
      if (store === undefined) {
        throw new Error(`Virtual workdir session not found: ${sessionId}`);
      }
      return openVirtualWorkdirSession(source, store);
    },

    deleteSession(sessionId: VirtualWorkdirSessionId): void {
      if (!sessions.delete(sessionId)) {
        throw new Error(`Virtual workdir session not found: ${sessionId}`);
      }
    },

    listSessions(): VirtualWorkdirSessionId[] {
      return Array.from(sessions.keys());
    },
  };
}

function resetState(state: VirtualWorkdirMemoryState, baseTree: SHA1): void {
  state.baseTree = baseTree;
  state.nodes.clear();
  state.nodes.set(VIRTUAL_ROOT_NODE_ID, createRootDirectoryNode(baseTree));
  state.changeLog.clear();
}

interface VirtualWorkdirMemoryStateSnapshot {
  readonly baseTree: SHA1;
  readonly nodes: ReadonlyMap<NodeId, SessionNode>;
  readonly changes: readonly InternalChangeRecord[];
}

function snapshotState(state: VirtualWorkdirMemoryState): VirtualWorkdirMemoryStateSnapshot {
  const nodes = new Map<NodeId, SessionNode>();
  for (const [nodeId, node] of state.nodes) {
    nodes.set(nodeId, cloneSessionNode(node));
  }
  return {
    baseTree: state.baseTree,
    nodes,
    changes: state.changeLog.snapshot(),
  };
}

function restoreState(
  state: VirtualWorkdirMemoryState,
  snapshot: VirtualWorkdirMemoryStateSnapshot,
): void {
  state.baseTree = snapshot.baseTree;
  state.nodes.clear();
  for (const [nodeId, node] of snapshot.nodes) {
    state.nodes.set(nodeId, cloneSessionNode(node));
  }
  state.changeLog.clear();
  for (const record of snapshot.changes) {
    state.changeLog.append(record);
  }
}

function cloneSessionNode(node: SessionNode): SessionNode {
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
