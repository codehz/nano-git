/**
 * VirtualWorkdir 行为编排
 *
 * Phase 5：完整文件/目录 rename 与 copy 语义。
 */

import {
  VirtualNotDirectoryError,
  VirtualNotFileError,
  VirtualNotSymlinkError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
  VirtualRevertNotSupportedError,
} from "../core/errors.ts";
import { createChangeIndexPlanner } from "./change-index-plan.ts";
import {
  refreshChangeRecordForPath,
  rebuildNormalizedChangeIndex,
  replaceChangeRecords,
  rewriteChangeRecordForRename,
  writeChangeRecordForCopy,
} from "./change-index.ts";
import { computeVirtualDiff } from "./change-index.ts";
import { createDirtyDirPlanner } from "./dirty-dir-plan.ts";
import { createNodeId } from "./ids.ts";
import { createVirtualWorkdirMemoryStateStore } from "./memory-backend.ts";
import { revertNodeState, type WorkdirNode } from "./nodes.ts";
import { modeToVirtualEntryKind, readRepoBlobContent } from "./origin.ts";
import { overlayBindEntry, overlayTombstoneEntry, overlayRenameEntry } from "./overlay.ts";
import { assertValidVirtualPath, normalizeDirectoryPath, VIRTUAL_ROOT_PATH } from "./path.ts";
import {
  getDirectoryChildrenView,
  getRootNode,
  requireMissingWriteTarget,
  requireExistingWriteTarget,
  resolvePath,
  resolveLeafWriteTarget,
  resolveWriteTransfer,
} from "./workdir-path.ts";
import {
  cloneNodeGraphForCopy,
  runInWriteTransaction,
  statDirectoryNode,
  statNode,
  updateParentOverlay,
} from "./workdir-transaction.ts";
import { writeTreeFromSession } from "./write-tree.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectDatabase } from "../core/types/odb.ts";
import type {
  CreateVirtualWorkdirOptions,
  VirtualDirEntry,
  VirtualDiffEntry,
  VirtualEntryStat,
  VirtualWorkdir,
} from "./core.ts";
import type { NodeId } from "./ids.ts";
import type { VirtualWorkdirStateStore } from "./state-store.ts";

// ==================== 工厂 ====================

/**
 * 基于 ObjectDatabase 创建 VirtualWorkdir
 *
 * @example
 * ```ts
 * const repo = createMemoryRepository();
 * const tree = repo.createTree([]);
 * const workdir = createVirtualWorkdir(repo.objects, { baseTree: tree });
 * expect(workdir.readdir()).toEqual([]);
 * ```
 */
export function createVirtualWorkdir(
  source: ObjectDatabase,
  options: CreateVirtualWorkdirOptions,
): VirtualWorkdir {
  const state = createVirtualWorkdirMemoryStateStore(options.baseTree);
  return openVirtualWorkdir(source, state);
}

// ==================== API 组装 ====================

/**
 * 基于已有状态存储打开 VirtualWorkdir
 *
 * @example
 * ```ts
 * const store = createVirtualWorkdirMemoryStateStore(tree);
 * const workdir = openVirtualWorkdir(repo.objects, store);
 * expect(workdir.baseTree).toBe(tree);
 * ```
 */
export function openVirtualWorkdir(
  source: ObjectDatabase,
  state: VirtualWorkdirStateStore,
): VirtualWorkdir {
  const currentNodeHashes = new Map<NodeId, SHA1>();
  const invalidateDiffCaches = (): void => {
    currentNodeHashes.clear();
  };
  const refreshChangeIndex = (): void => {
    invalidateDiffCaches();
    replaceChangeRecords(
      state,
      rebuildNormalizedChangeIndex(source, state, {
        currentNodeHashes,
        setCurrentNodeHash(nodeId, hash): void {
          currentNodeHashes.set(nodeId, hash);
        },
      }),
    );
  };
  const refreshChangeIndexForPath = (path: string): void => {
    invalidateDiffCaches();
    refreshChangeRecordForPath(source, state, path, {
      currentNodeHashes,
      setCurrentNodeHash(nodeId, hash): void {
        currentNodeHashes.set(nodeId, hash);
      },
    });
  };
  const rewriteChangeIndexForRename = (from: string, to: string): void => {
    invalidateDiffCaches();
    rewriteChangeRecordForRename(source, state, from, to, {
      currentNodeHashes,
      setCurrentNodeHash(nodeId, hash): void {
        currentNodeHashes.set(nodeId, hash);
      },
    });
  };
  const writeChangeIndexForCopy = (from: string, to: string): void => {
    invalidateDiffCaches();
    writeChangeRecordForCopy(source, state, from, to, {
      currentNodeHashes,
      setCurrentNodeHash(nodeId, hash): void {
        currentNodeHashes.set(nodeId, hash);
      },
    });
  };
  const changeIndexPlanner = createChangeIndexPlanner(source, state, {
    rebuildAll: refreshChangeIndex,
    refreshPath: refreshChangeIndexForPath,
    rewriteRename: rewriteChangeIndexForRename,
    writeCopy: writeChangeIndexForCopy,
  });
  const dirtyDirPlanner = createDirtyDirPlanner(source, state);

  refreshChangeIndex();

  const api: VirtualWorkdir = {
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
      return getDirectoryChildrenView(source, state, resolved.node, normalized).children.map(
        (child) => ({
          name: child.name,
          kind: modeToVirtualEntryKind(child.mode),
          mode: child.mode,
        }),
      );
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
      runInWriteTransaction(
        state,
        () => dirtyDirPlanner.rebuild([path]),
        invalidateDiffCaches,
        () => {
          const target = requireMissingWriteTarget(source, state, path);

          // 创建新目录节点 + 绑定到父 overlay
          const nodeId = createNodeId();
          const newNode: WorkdirNode = {
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
            target.parentNode.id,
            overlayBindEntry(target.parentNode.state.overlay, target.name, nodeId),
          );
        },
      );
    },

    writeFile(
      path: string,
      content: Buffer,
      options?: { readonly mode?: "100644" | "100755" },
    ): void {
      runInWriteTransaction(
        state,
        () => {
          changeIndexPlanner.apply(changeIndexPlanner.planRefreshForPath(path));
          dirtyDirPlanner.rebuild([path]);
        },
        invalidateDiffCaches,
        () => {
          const mode: "100644" | "100755" = options?.mode ?? "100644";
          const target = resolveLeafWriteTarget(source, state, path);

          const nodeId = target.existing !== null ? target.existing.node.id : createNodeId();

          const fileNode: WorkdirNode = {
            id: nodeId,
            origin: target.existing !== null ? target.existing.node.origin : { kind: "none" },
            state: { kind: "file", mode, content },
          };
          state.setNode(fileNode);
          if (
            target.existing === null ||
            target.parentNode.state.overlay.addedEntries.has(target.name)
          ) {
            updateParentOverlay(
              state,
              target.parentNode.id,
              overlayBindEntry(target.parentNode.state.overlay, target.name, nodeId),
            );
          }
        },
      );
    },

    writeLink(path: string, target: string): void {
      runInWriteTransaction(
        state,
        () => {
          changeIndexPlanner.apply(changeIndexPlanner.planRefreshForPath(path));
          dirtyDirPlanner.rebuild([path]);
        },
        invalidateDiffCaches,
        () => {
          const writeTarget = resolveLeafWriteTarget(source, state, path);

          const nodeId =
            writeTarget.existing !== null ? writeTarget.existing.node.id : createNodeId();

          const linkNode: WorkdirNode = {
            id: nodeId,
            origin:
              writeTarget.existing !== null ? writeTarget.existing.node.origin : { kind: "none" },
            state: { kind: "symlink", mode: "120000", target: Buffer.from(target) },
          };
          state.setNode(linkNode);
          if (
            writeTarget.existing === null ||
            writeTarget.parentNode.state.overlay.addedEntries.has(writeTarget.name)
          ) {
            updateParentOverlay(
              state,
              writeTarget.parentNode.id,
              overlayBindEntry(writeTarget.parentNode.state.overlay, writeTarget.name, nodeId),
            );
          }
        },
      );
    },

    delete(path: string): void {
      runInWriteTransaction(
        state,
        () => {
          changeIndexPlanner.apply(
            changeIndexPlanner.planRefreshForPath(path, { treatMissingAsIncremental: true }),
          );
          dirtyDirPlanner.rebuild([path]);
        },
        invalidateDiffCaches,
        () => {
          const target = requireExistingWriteTarget(source, state, path);

          updateParentOverlay(
            state,
            target.parentNode.id,
            overlayTombstoneEntry(target.parentNode.state.overlay, target.name),
          );
        },
      );
    },

    rename(from: string, to: string): void {
      runInWriteTransaction(
        state,
        () => {
          changeIndexPlanner.apply(changeIndexPlanner.planRewriteForRename(from, to));
          dirtyDirPlanner.rebuild([from, to]);
        },
        invalidateDiffCaches,
        () => {
          assertValidVirtualPath(from);
          assertValidVirtualPath(to);

          if (from === to) {
            return;
          }

          const { from: fromTarget, to: toTarget } = resolveWriteTransfer(source, state, from, to);
          const sourceNode = fromTarget.existing.node;

          // 检查目标是否已存在
          if (toTarget.existing !== null) {
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

          if (fromTarget.parentNode.id === toTarget.parentNode.id) {
            // 同目录 rename：单次 overlayRenameEntry 操作
            updateParentOverlay(
              state,
              fromTarget.parentNode.id,
              overlayRenameEntry(
                fromTarget.parentNode.state.overlay,
                fromTarget.name,
                toTarget.name,
                sourceNode.id,
              ),
            );
          } else {
            // 跨目录 rename：先解绑源，再绑定目标
            updateParentOverlay(
              state,
              fromTarget.parentNode.id,
              overlayTombstoneEntry(fromTarget.parentNode.state.overlay, fromTarget.name),
            );
            updateParentOverlay(
              state,
              toTarget.parentNode.id,
              overlayBindEntry(toTarget.parentNode.state.overlay, toTarget.name, sourceNode.id),
            );
          }
        },
      );
    },

    copy(from: string, to: string): void {
      runInWriteTransaction(
        state,
        () => {
          changeIndexPlanner.apply(changeIndexPlanner.planWriteForCopy(from, to));
          dirtyDirPlanner.rebuild([from, to]);
        },
        invalidateDiffCaches,
        () => {
          assertValidVirtualPath(from);
          assertValidVirtualPath(to);

          if (from === to) {
            throw new VirtualPathAlreadyExistsError(to);
          }

          const { from: fromTarget, to: toTarget } = resolveWriteTransfer(source, state, from, to);
          const sourceNode = fromTarget.existing.node;

          // 检查目标是否已存在
          if (toTarget.existing !== null) {
            throw new VirtualPathAlreadyExistsError(to);
          }

          // 创建新节点图，避免 copy 后源与目标共享子节点身份
          const newNodeId = cloneNodeGraphForCopy(source, state, sourceNode, from);

          // 绑定到目标父目录
          updateParentOverlay(
            state,
            toTarget.parentNode.id,
            overlayBindEntry(toTarget.parentNode.state.overlay, toTarget.name, newNodeId),
          );
        },
      );
    },

    revert(path: string): void {
      runInWriteTransaction(
        state,
        () => {
          changeIndexPlanner.apply(changeIndexPlanner.planRefreshForPath(path));
          dirtyDirPlanner.rebuild([path]);
        },
        invalidateDiffCaches,
        () => {
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
        },
      );
    },

    diff(): VirtualDiffEntry[] {
      return computeVirtualDiff(state);
    },

    writeTree() {
      return writeTreeFromSession(source, state);
    },

    reset(baseTree) {
      runInWriteTransaction(state, null, invalidateDiffCaches, () => {
        state.reset(baseTree);
        dirtyDirPlanner.clear();
      });
    },
  };

  return api;
}
