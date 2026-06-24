/**
 * VirtualWorkdirSession 行为编排
 *
 * Phase 5：完整文件/目录 rename 与 copy 语义。
 */

import {
  VirtualNotDirectoryError,
  VirtualNotFileError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
  VirtualRevertNotSupportedError,
  VirtualNotSymlinkError,
} from "../core/errors.ts";
import { computeVirtualDiff } from "./diff.ts";
import { VIRTUAL_ROOT_NODE_ID, createNodeId } from "./ids.ts";
import { createVirtualWorkdirMemoryStateStore } from "./memory-backend.ts";
import { cloneSessionNodeForCopy, revertNodeState, type SessionNode } from "./nodes.ts";
import { modeToVirtualEntryKind, readRepoBlobContent } from "./origin.ts";
import { overlayBindEntry, overlayTombstoneEntry, overlayRenameEntry } from "./overlay.ts";
import {
  assertValidVirtualPath,
  normalizeDirectoryPath,
  parentPath,
  baseName,
  VIRTUAL_ROOT_PATH,
} from "./path.ts";
import { resolvePath, resolveChild, listDirectoryChildren } from "./session-internal.ts";
import { writeTreeFromSession } from "./write-tree.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectDatabase } from "../core/types/odb.ts";
import type {
  CreateVirtualWorkdirSessionOptions,
  VirtualDirEntry,
  VirtualDiffEntry,
  VirtualEntryStat,
  VirtualWorkdirSession,
} from "./core.ts";
import type { NodeId } from "./ids.ts";
import type { VirtualWorkdirStateStore } from "./state-store.ts";

// ==================== 工厂 ====================

/**
 * 基于 ObjectDatabase 创建 VirtualWorkdirSession
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
  source: ObjectDatabase,
  options: CreateVirtualWorkdirSessionOptions,
): VirtualWorkdirSession {
  const state = createVirtualWorkdirMemoryStateStore(options.baseTree);
  return openVirtualWorkdirSession(source, state);
}

// ==================== API 组装 ====================

/**
 * 基于已有状态存储打开 session
 *
 * @example
 * ```ts
 * const store = createVirtualWorkdirMemoryStateStore(tree);
 * const session = openVirtualWorkdirSession(repo.objects, store);
 * expect(session.baseTree).toBe(tree);
 * ```
 */
export function openVirtualWorkdirSession(
  source: ObjectDatabase,
  state: VirtualWorkdirStateStore,
): VirtualWorkdirSession {
  const currentNodeHashes = new Map<NodeId, SHA1>();
  const invalidateDiffCaches = (): void => {
    currentNodeHashes.clear();
  };

  const api: VirtualWorkdirSession = {
    get baseTree() {
      return state.readBaseTree();
    },

    // ========== 只读 ==========

    exists(path: string): boolean {
      if (path === VIRTUAL_ROOT_PATH) {
        return true;
      }
      return resolvePath(source, state, path).found;
    },

    stat(path: string): VirtualEntryStat | null {
      if (path === VIRTUAL_ROOT_PATH) {
        return statDirectoryNode(getRootNode(state));
      }
      const resolved = resolvePath(source, state, path);
      if (!resolved.found || resolved.node === null) {
        return null;
      }
      return statNode(source, resolved.node, path);
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

    // ========== 写入 ==========

    mkdir(path: string): void {
      runInWriteTransaction(state, invalidateDiffCaches, () => {
        assertValidVirtualPath(path);
        const parent = parentPath(path);
        const name = baseName(path);

        const parentResolved =
          parent !== null
            ? resolvePath(source, state, parent)
            : { found: true, node: getRootNode(state) };
        if (!parentResolved.found || parentResolved.node === null) {
          throw new VirtualPathNotFoundError(parent ?? path);
        }
        const parentNode = parentResolved.node;
        if (parentNode.state.kind !== "directory") {
          throw new VirtualNotDirectoryError(parent ?? path);
        }

        // 检查是否已存在
        const existing = resolveChild(source, state, parentNode, parent ?? VIRTUAL_ROOT_PATH, name);
        if (existing.found && existing.node !== null) {
          throw new VirtualPathAlreadyExistsError(path);
        }

        // 创建新目录节点 + 绑定到父 overlay
        const nodeId = createNodeId();
        const newNode: SessionNode = {
          id: nodeId,
          origin: { kind: "none" },
          state: {
            kind: "directory",
            overlay: { addedEntries: new Map(), deletedNames: new Set() },
          },
        };
        state.setNode(newNode);
        updateParentOverlay(
          state,
          parentNode.id,
          overlayBindEntry(parentNode.state.overlay, name, nodeId),
        );
      });
    },

    writeFile(
      path: string,
      content: Buffer,
      options?: { readonly mode?: "100644" | "100755" },
    ): void {
      runInWriteTransaction(state, invalidateDiffCaches, () => {
        assertValidVirtualPath(path);
        const mode: "100644" | "100755" = options?.mode ?? "100644";
        const parent = parentPath(path);
        const name = baseName(path);

        const parentResolved =
          parent !== null
            ? resolvePath(source, state, parent)
            : { found: true, node: getRootNode(state) };
        if (!parentResolved.found || parentResolved.node === null) {
          throw new VirtualPathNotFoundError(parent ?? path);
        }
        const parentNode = parentResolved.node;
        if (parentNode.state.kind !== "directory") {
          throw new VirtualNotDirectoryError(parent ?? path);
        }

        // 检查是否已存在且为目录
        const existing = resolveChild(source, state, parentNode, parent ?? VIRTUAL_ROOT_PATH, name);
        if (existing.found && existing.node !== null) {
          if (existing.node.state.kind === "directory") {
            throw new VirtualNotFileError(path);
          }
        }

        const nodeId = existing.found ? existing.node.id : createNodeId();

        const fileNode: SessionNode = {
          id: nodeId,
          origin: existing.found ? existing.node.origin : { kind: "none" },
          state: { kind: "file", mode, content },
        };
        state.setNode(fileNode);
        updateParentOverlay(
          state,
          parentNode.id,
          overlayBindEntry(parentNode.state.overlay, name, nodeId),
        );
      });
    },

    writeLink(path: string, target: string): void {
      runInWriteTransaction(state, invalidateDiffCaches, () => {
        assertValidVirtualPath(path);
        const parent = parentPath(path);
        const name = baseName(path);

        const parentResolved =
          parent !== null
            ? resolvePath(source, state, parent)
            : { found: true, node: getRootNode(state) };
        if (!parentResolved.found || parentResolved.node === null) {
          throw new VirtualPathNotFoundError(parent ?? path);
        }
        const parentNode = parentResolved.node;
        if (parentNode.state.kind !== "directory") {
          throw new VirtualNotDirectoryError(parent ?? path);
        }

        const existing = resolveChild(source, state, parentNode, parent ?? VIRTUAL_ROOT_PATH, name);
        if (existing.found && existing.node !== null) {
          if (existing.node.state.kind === "directory") {
            throw new VirtualNotFileError(path);
          }
        }

        const nodeId = existing.found ? existing.node.id : createNodeId();

        const linkNode: SessionNode = {
          id: nodeId,
          origin: existing.found ? existing.node.origin : { kind: "none" },
          state: { kind: "symlink", mode: "120000", target: Buffer.from(target) },
        };
        state.setNode(linkNode);
        updateParentOverlay(
          state,
          parentNode.id,
          overlayBindEntry(parentNode.state.overlay, name, nodeId),
        );
      });
    },

    delete(path: string): void {
      runInWriteTransaction(state, invalidateDiffCaches, () => {
        assertValidVirtualPath(path);
        const parent = parentPath(path);
        const name = baseName(path);

        const parentResolved =
          parent !== null
            ? resolvePath(source, state, parent)
            : { found: true, node: getRootNode(state) };
        if (!parentResolved.found || parentResolved.node === null) {
          throw new VirtualPathNotFoundError(parent ?? path);
        }
        const parentNode = parentResolved.node;
        if (parentNode.state.kind !== "directory") {
          throw new VirtualNotDirectoryError(parent ?? path);
        }

        // 确认目标存在
        const existing = resolveChild(source, state, parentNode, parent ?? VIRTUAL_ROOT_PATH, name);
        if (!existing.found || existing.node === null) {
          throw new VirtualPathNotFoundError(path);
        }

        updateParentOverlay(
          state,
          parentNode.id,
          overlayTombstoneEntry(parentNode.state.overlay, name),
        );
      });
    },

    rename(from: string, to: string): void {
      runInWriteTransaction(state, invalidateDiffCaches, () => {
        assertValidVirtualPath(from);
        assertValidVirtualPath(to);

        if (from === to) {
          return;
        }

        // 解析源路径
        const fromParent = parentPath(from);
        const fromName = baseName(from);
        const fromParentResolved =
          fromParent !== null
            ? resolvePath(source, state, fromParent)
            : { found: true, node: getRootNode(state) };
        if (!fromParentResolved.found || fromParentResolved.node === null) {
          throw new VirtualPathNotFoundError(from);
        }
        const fromParentNode = fromParentResolved.node;
        if (fromParentNode.state.kind !== "directory") {
          throw new VirtualNotDirectoryError(from);
        }

        // 确认源存在
        const fromChild = resolveChild(
          source,
          state,
          fromParentNode,
          fromParent ?? VIRTUAL_ROOT_PATH,
          fromName,
        );
        if (!fromChild.found || fromChild.node === null) {
          throw new VirtualPathNotFoundError(from);
        }
        const sourceNode = fromChild.node;

        // 解析目标父目录
        const toParent = parentPath(to);
        const toName = baseName(to);
        const toParentResolved =
          toParent !== null
            ? resolvePath(source, state, toParent)
            : { found: true, node: getRootNode(state) };
        if (!toParentResolved.found || toParentResolved.node === null) {
          throw new VirtualPathNotFoundError(to);
        }
        const toParentNode = toParentResolved.node;
        if (toParentNode.state.kind !== "directory") {
          throw new VirtualNotDirectoryError(to);
        }

        // 检查目标是否已存在
        const toExisting = resolveChild(
          source,
          state,
          toParentNode,
          toParent ?? VIRTUAL_ROOT_PATH,
          toName,
        );
        if (toExisting.found && toExisting.node !== null) {
          throw new VirtualPathAlreadyExistsError(to);
        }

        // 检查 rename 是否将目录移入自身子目录
        if (sourceNode.state.kind === "directory") {
          const toPath = to;
          const fromPath = from;
          if (toPath.startsWith(fromPath + "/") || toPath === fromPath) {
            throw new Error(
              `Cannot rename '${from}' to '${to}': destination is a subdirectory of source`,
            );
          }
        }

        if (fromParentNode.id === toParentNode.id) {
          // 同目录 rename：单次 overlayRenameEntry 操作
          updateParentOverlay(
            state,
            fromParentNode.id,
            overlayRenameEntry(fromParentNode.state.overlay, fromName, toName, sourceNode.id),
          );
        } else {
          // 跨目录 rename：先解绑源，再绑定目标
          updateParentOverlay(
            state,
            fromParentNode.id,
            overlayTombstoneEntry(fromParentNode.state.overlay, fromName),
          );
          updateParentOverlay(
            state,
            toParentNode.id,
            overlayBindEntry(toParentNode.state.overlay, toName, sourceNode.id),
          );
        }
      });
    },

    copy(from: string, to: string): void {
      runInWriteTransaction(state, invalidateDiffCaches, () => {
        assertValidVirtualPath(from);
        assertValidVirtualPath(to);

        if (from === to) {
          throw new VirtualPathAlreadyExistsError(to);
        }

        // 解析源路径
        const fromParent = parentPath(from);
        const fromName = baseName(from);
        const fromParentResolved =
          fromParent !== null
            ? resolvePath(source, state, fromParent)
            : { found: true, node: getRootNode(state) };
        if (!fromParentResolved.found || fromParentResolved.node === null) {
          throw new VirtualPathNotFoundError(from);
        }
        const fromParentNode = fromParentResolved.node;
        if (fromParentNode.state.kind !== "directory") {
          throw new VirtualNotDirectoryError(from);
        }

        // 确认源存在
        const fromChild = resolveChild(
          source,
          state,
          fromParentNode,
          fromParent ?? VIRTUAL_ROOT_PATH,
          fromName,
        );
        if (!fromChild.found || fromChild.node === null) {
          throw new VirtualPathNotFoundError(from);
        }
        const sourceNode = fromChild.node;

        // 解析目标父目录
        const toParent = parentPath(to);
        const toName = baseName(to);
        const toParentResolved =
          toParent !== null
            ? resolvePath(source, state, toParent)
            : { found: true, node: getRootNode(state) };
        if (!toParentResolved.found || toParentResolved.node === null) {
          throw new VirtualPathNotFoundError(to);
        }
        const toParentNode = toParentResolved.node;
        if (toParentNode.state.kind !== "directory") {
          throw new VirtualNotDirectoryError(to);
        }

        // 检查目标是否已存在
        const toExisting = resolveChild(
          source,
          state,
          toParentNode,
          toParent ?? VIRTUAL_ROOT_PATH,
          toName,
        );
        if (toExisting.found && toExisting.node !== null) {
          throw new VirtualPathAlreadyExistsError(to);
        }

        // 创建新节点图，避免 copy 后源与目标共享子节点身份
        const newNodeId = cloneNodeGraphForCopy(source, state, sourceNode, from);

        // 绑定到目标父目录
        updateParentOverlay(
          state,
          toParentNode.id,
          overlayBindEntry(toParentNode.state.overlay, toName, newNodeId),
        );
      });
    },

    revert(path: string): void {
      runInWriteTransaction(state, invalidateDiffCaches, () => {
        assertValidVirtualPath(path);
        const resolved = resolvePath(source, state, path);
        if (!resolved.found || resolved.node === null) {
          throw new VirtualPathNotFoundError(path);
        }

        const node = resolved.node;
        const reverted = revertNodeState(node);
        if (reverted === node) {
          throw new VirtualRevertNotSupportedError(path);
        }
        state.setNode(reverted);
      });
    },

    diff(): VirtualDiffEntry[] {
      return computeVirtualDiff(source, state, {
        currentNodeHashes,
        setCurrentNodeHash(nodeId, hash): void {
          currentNodeHashes.set(nodeId, hash);
        },
      });
    },

    writeTree() {
      return writeTreeFromSession(source, state);
    },

    reset(baseTree) {
      runInWriteTransaction(state, invalidateDiffCaches, () => {
        state.reset(baseTree);
      });
    },
  };

  return api;
}
// ==================== 辅助 ====================

function getRootNode(state: VirtualWorkdirStateStore): SessionNode {
  const root = state.getNode(VIRTUAL_ROOT_NODE_ID);
  if (root === null) {
    throw new Error("Virtual workdir session is missing root node");
  }
  return root;
}

function runInWriteTransaction<T>(
  state: VirtualWorkdirStateStore,
  onCommitted: () => void,
  fn: () => T,
): T {
  const result = state.transact(fn);
  onCommitted();
  return result;
}

/**
 * 更新父节点的 overlay（创建新节点对象替代 Map 中的旧引用）
 */
function updateParentOverlay(
  state: VirtualWorkdirStateStore,
  parentId: NodeId,
  newOverlay: import("./overlay.ts").DirectoryOverlay,
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

function statNode(source: ObjectDatabase, node: SessionNode, path: string): VirtualEntryStat {
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

function statDirectoryNode(node: SessionNode): VirtualEntryStat {
  const hash = node.origin.kind === "repo-tree" ? node.origin.hash : null;
  return { kind: "tree", mode: "40000", size: 0, hash };
}

function cloneNodeGraphForCopy(
  source: ObjectDatabase,
  state: VirtualWorkdirStateStore,
  node: SessionNode,
  path: string,
): NodeId {
  const newNodeId = createNodeId();
  const cloned = cloneSessionNodeForCopy(node, newNodeId);
  state.setNode(cloned);

  if (node.state.kind !== "directory" || cloned.state.kind !== "directory") {
    return newNodeId;
  }

  let overlay = cloned.state.overlay;
  const children = listDirectoryChildren(source, state, node, path);
  for (const child of children) {
    const childNode = state.getNode(child.nodeId);
    if (childNode === null) {
      continue;
    }
    const childPath = path === VIRTUAL_ROOT_PATH ? child.name : `${path}/${child.name}`;
    const clonedChildId = cloneNodeGraphForCopy(source, state, childNode, childPath);
    overlay = overlayBindEntry(overlay, child.name, clonedChildId);
  }

  state.setNode({
    ...cloned,
    state: { kind: "directory", overlay },
  });
  return newNodeId;
}
