/**
 * VirtualWorkdirSession 行为编排
 *
 * Phase 3：repo-backed 只读视图；写操作在后续 Phase 补齐。
 */

import {
  VirtualNotDirectoryError,
  VirtualNotFileError,
  VirtualNotSymlinkError,
  VirtualPathNotFoundError,
} from "../core/errors.ts";
import { originBackedNodeId, VIRTUAL_ROOT_NODE_ID } from "./ids.ts";
import {
  createVirtualWorkdirMemoryState,
  type VirtualWorkdirMemoryState,
} from "./memory-backend.ts";
import {
  modeToVirtualEntryKind,
  readRepoBlobContent,
  readRepoTree,
  treeEntryToNodeOrigin,
} from "./origin.ts";
import {
  mergeDirectoryChildren,
  type MergedDirectoryChild,
  type OriginDirectoryChild,
} from "./overlay.ts";
import {
  assertValidVirtualPath,
  joinPath,
  normalizeDirectoryPath,
  splitPathSegments,
  VIRTUAL_ROOT_PATH,
} from "./path.ts";

import type { TreeEntry } from "../core/types.ts";
import type { ObjectSource } from "../core/types/odb.ts";
import type {
  CreateVirtualWorkdirSessionOptions,
  VirtualChange,
  VirtualDirEntry,
  VirtualEntryStat,
  VirtualWorkdirSession,
} from "./core.ts";
import type { NodeId } from "./ids.ts";
import type { SessionNode } from "./nodes.ts";

// ==================== 工厂 ====================

/**
 * 基于 ObjectSource 创建 VirtualWorkdirSession
 *
 * memory / file 公开工厂在后续 Phase 复用此函数。
 *
 * @example
 * ```ts
 * const repo = createMemoryRepository();
 * const tree = repo.createTree([]);
 * const session = createVirtualWorkdirSession(repo.objects, { baseTree: tree });
 * expect(session.readdir()).toEqual([]);
 * ```
 */
export function createVirtualWorkdirSession(
  source: ObjectSource,
  options: CreateVirtualWorkdirSessionOptions,
): VirtualWorkdirSession {
  const state = createVirtualWorkdirMemoryState(options.baseTree);
  return buildSessionApi(source, state);
}

function buildSessionApi(
  source: ObjectSource,
  state: VirtualWorkdirMemoryState,
): VirtualWorkdirSession {
  const api: VirtualWorkdirSession = {
    get baseTree() {
      return state.baseTree;
    },

    exists(path: string): boolean {
      if (path === VIRTUAL_ROOT_PATH) {
        return true;
      }
      return resolvePath(source, state, path).found;
    },

    stat(path: string): VirtualEntryStat | null {
      if (path === VIRTUAL_ROOT_PATH) {
        return statDirectoryNode(source, state, getRootNode(state), VIRTUAL_ROOT_PATH);
      }
      const resolved = resolvePath(source, state, path);
      if (!resolved.found || resolved.node === null) {
        return null;
      }
      return statNode(source, state, resolved.node, path);
    },

    readdir(dirPath?: string): VirtualDirEntry[] {
      const normalized = normalizeDirectoryPath(dirPath);
      const resolved =
        normalized === VIRTUAL_ROOT_PATH
          ? { found: true, node: getRootNode(state) }
          : resolvePath(source, state, normalized);
      if (!resolved.found || resolved.node === null) {
        throw new VirtualPathNotFoundError(normalized);
      }
      if (resolved.node.state.kind !== "directory") {
        throw new VirtualNotDirectoryError(normalized);
      }
      const children = listDirectoryChildren(source, state, resolved.node, normalized);
      return children.map((child) => ({
        name: child.name,
        kind: modeToVirtualEntryKind(child.mode),
        mode: child.mode,
      }));
    },

    readFile(path: string): Buffer {
      assertValidVirtualPath(path);
      const resolved = resolvePath(source, state, path);
      if (!resolved.found || resolved.node === null) {
        throw new VirtualPathNotFoundError(path);
      }
      const node = resolved.node;
      if (node.state.kind === "file") {
        if (node.state.content !== undefined) {
          return node.state.content;
        }
        if (node.origin.kind === "repo-blob") {
          return readRepoBlobContent(source, node.origin.hash, path);
        }
        throw new VirtualPathNotFoundError(path);
      }
      if (node.state.kind === "symlink") {
        throw new VirtualNotFileError(path);
      }
      throw new VirtualNotFileError(path);
    },

    readLink(path: string): string {
      assertValidVirtualPath(path);
      const resolved = resolvePath(source, state, path);
      if (!resolved.found || resolved.node === null) {
        throw new VirtualPathNotFoundError(path);
      }
      const node = resolved.node;
      if (node.state.kind !== "symlink") {
        throw new VirtualNotSymlinkError(path);
      }
      if (node.state.target !== undefined) {
        return node.state.target.toString("utf-8");
      }
      if (node.origin.kind === "repo-blob") {
        const buf = readRepoBlobContent(source, node.origin.hash, path);
        return buf.toString("utf-8");
      }
      throw new VirtualPathNotFoundError(path);
    },

    writeFile: notImplemented,
    writeLink: notImplemented,
    mkdir: notImplemented,
    delete: notImplemented,
    rename: notImplemented,
    copy: notImplemented,
    revert: notImplemented,
    writeTree: notImplemented,
    reset: notImplemented,
    listChanges(): VirtualChange[] {
      return state.changeLog.toVirtualChanges();
    },
  };

  return api;
}

function notImplemented(): never {
  throw new Error("Virtual workdir: operation not implemented in this phase");
}

// ==================== 路径解析 ====================

type ResolveResult =
  | { readonly found: false; readonly node: null }
  | { readonly found: true; readonly node: SessionNode };

function getRootNode(state: VirtualWorkdirMemoryState): SessionNode {
  const root = state.nodes.get(VIRTUAL_ROOT_NODE_ID);
  if (root === undefined) {
    throw new Error("Virtual workdir session is missing root node");
  }
  return root;
}

function resolvePath(
  source: ObjectSource,
  state: VirtualWorkdirMemoryState,
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
    const children = listDirectoryChildren(source, state, current, currentPath);
    const child = children.find((c) => c.name === segment);
    if (child === undefined) {
      return { found: false, node: null };
    }
    currentPath = joinPath(currentPath === VIRTUAL_ROOT_PATH ? null : currentPath, segment);
    const childNode = state.nodes.get(child.nodeId);
    if (childNode === undefined) {
      return { found: false, node: null };
    }
    current = childNode;
  }

  return { found: true, node: current };
}

function ensureNodeFromTreeEntry(state: VirtualWorkdirMemoryState, entry: TreeEntry): NodeId {
  const id = originBackedNodeId(entry.hash);
  if (!state.nodes.has(id)) {
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
      const mode = entry.mode === "100755" ? "100755" : "100644";
      nodeState = { kind: "file", mode };
    }
    state.nodes.set(id, { id, origin, state: nodeState });
  }
  return id;
}

function listDirectoryChildren(
  source: ObjectSource,
  state: VirtualWorkdirMemoryState,
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
      const nodeId = ensureNodeFromTreeEntry(state, entry);
      return { name: entry.name, mode: entry.mode, nodeId };
    });
  }

  const addedModes = new Map<string, string>();
  for (const name of dirNode.state.overlay.addedEntries.keys()) {
    const nodeId = dirNode.state.overlay.addedEntries.get(name)!;
    const node = state.nodes.get(nodeId);
    if (node !== undefined) {
      addedModes.set(name, sessionNodeMode(node));
    }
  }

  return mergeDirectoryChildren(originChildren, dirNode.state.overlay, addedModes);
}

function sessionNodeMode(node: SessionNode): string {
  if (node.state.kind === "directory") {
    return "40000";
  }
  if (node.state.kind === "symlink") {
    return "120000";
  }
  return node.state.mode;
}

function statNode(
  source: ObjectSource,
  state: VirtualWorkdirMemoryState,
  node: SessionNode,
  path: string,
): VirtualEntryStat {
  if (node.state.kind === "directory") {
    return statDirectoryNode(source, state, node, path);
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

function statDirectoryNode(
  source: ObjectSource,
  _state: VirtualWorkdirMemoryState,
  node: SessionNode,
  _path: string,
): VirtualEntryStat {
  const hash = node.origin.kind === "repo-tree" ? node.origin.hash : null;
  return { kind: "tree", mode: "40000", size: 0, hash };
}
