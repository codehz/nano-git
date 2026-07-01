/**
 * VirtualWorktree 行为编排
 *
 * 负责组装 VirtualWorktree 的读写、结构变更与导出行为。
 */

import {
  VirtualNotDirectoryError,
  VirtualNotFileError,
  VirtualNotSymlinkError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
} from "../../errors.ts";
import { createNodeId } from "../model/ids.ts";
import { type WorktreeNode } from "../model/nodes.ts";
import { modeToVirtualEntryKind, readRepoBlobContent } from "../model/origin.ts";
import { overlayBindEntry, overlayTombstoneEntry } from "../model/overlay.ts";
import {
  assertValidVirtualPath,
  normalizeDirectoryPath,
  parentPath,
  splitPathSegments,
  VIRTUAL_ROOT_PATH,
} from "../model/path.ts";
import { createVirtualWorktreeMemoryStateStore } from "../store/memory-backend.ts";
import { createChangeIndexPlanner } from "./change-index-plan.ts";
import { rebuildNormalizedChangeIndex, replaceChangeRecords } from "./change-index.ts";
import { computeVirtualDiff } from "./change-index.ts";
import {
  getDirectoryChildrenView,
  getRootNode,
  requireMissingWriteTarget,
  requireExistingWriteTarget,
  resolvePath,
  resolveLeafWriteTarget,
  resolveWriteTransfer,
} from "./worktree-path.ts";
import { restorePathFromBase } from "./worktree-restore.ts";
import {
  cloneNodeGraphForCopy,
  runInWriteTransaction,
  statDirectoryNode,
  statNode,
  updateParentOverlay,
} from "./worktree-transaction.ts";
import { writeTreeFromSession } from "./write-tree.ts";

import type { DiffEntry } from "../../diff.ts";
import type { SHA1 } from "../../types/index.ts";
import type { ObjectDatabase } from "../../types/odb.ts";
import type {
  InitializeVirtualWorktreeOptions,
  VirtualDirEntry,
  VirtualEntryStat,
  VirtualWorktree,
} from "../core.ts";
import type { NodeId } from "../model/ids.ts";
import type { VirtualWorktreeStateStore } from "../store/state-store.ts";

// ==================== 工厂 ====================

/**
 * 基于 ObjectDatabase 创建内存版 VirtualWorktree
 *
 * @param source - 用于读取基线 tree / blob 的对象库
 * @param options - 创建选项（`baseTree` 为初始基线）
 * @returns 可读写路径与导出 tree 的 VirtualWorktree 实例
 *
 * @example
 * ```ts
 * const repo = createMemoryRepository();
 * const tree = repo.createTree([]);
 * const worktree = createVirtualWorktree(repo.objects, { baseTree: tree });
 * expect(worktree.readdir()).toEqual([]);
 * ```
 */
export function createVirtualWorktree(
  source: ObjectDatabase,
  options: InitializeVirtualWorktreeOptions,
): VirtualWorktree {
  const state = createVirtualWorktreeMemoryStateStore(options.baseTree);
  return openVirtualWorktree(source, state);
}

// ==================== API 组装 ====================

/**
 * 基于已有状态存储打开 VirtualWorktree
 *
 * 供内存、文件、SQLite 等持久化后端在绑定 `VirtualWorktreeStateStore` 后复用同一套行为实现。
 *
 * @param source - 用于读取 origin 对象的 ODB
 * @param state - 已初始化的状态存储（含 `baseTree` 与可选 overlay）
 * @returns 与 `createVirtualWorktree` 相同 API 的 VirtualWorktree 实例
 *
 * @example
 * ```ts
 * const store = createVirtualWorktreeMemoryStateStore(tree);
 * const worktree = openVirtualWorktree(repo.objects, store);
 * expect(worktree.baseTree).toBe(tree);
 * ```
 */
export function openVirtualWorktree(
  source: ObjectDatabase,
  state: VirtualWorktreeStateStore,
): VirtualWorktree {
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
  const changeIndexPlanner = createChangeIndexPlanner(source, state, {
    rebuildAll: refreshChangeIndex,
    refreshPath: refreshChangeIndex,
  });
  refreshChangeIndex();

  const createDirectoryAtPath = (path: string): void => {
    const target = requireMissingWriteTarget(source, state, path);
    const nodeId = createNodeId();
    const newNode: WorktreeNode = {
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
  };

  const mkdirRecursive = (path: string): void => {
    const segments = splitPathSegments(path);
    for (let i = 0; i < segments.length; i++) {
      const partialPath = segments.slice(0, i + 1).join("/");
      const resolved = resolvePath(source, state, partialPath);
      if (resolved.found && resolved.node !== null) {
        if (resolved.node.state.kind !== "directory") {
          throw new VirtualNotDirectoryError(partialPath);
        }
        continue;
      }
      createDirectoryAtPath(partialPath);
    }
  };

  const api: VirtualWorktree = {
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

    mkdir(path: string, options?: { readonly recursive?: boolean }): void {
      const recursive = options?.recursive === true;
      runInWriteTransaction(
        state,
        () => {
          changeIndexPlanner.apply({ kind: "rebuild-all" });
        },
        invalidateDiffCaches,
        () => {
          if (recursive) {
            mkdirRecursive(path);
          } else {
            createDirectoryAtPath(path);
          }
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
        },
        invalidateDiffCaches,
        () => {
          const mode: "100644" | "100755" = options?.mode ?? "100644";
          const target = resolveLeafWriteTarget(source, state, path);

          const nodeId = target.existing !== null ? target.existing.node.id : createNodeId();

          const fileNode: WorktreeNode = {
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
        },
        invalidateDiffCaches,
        () => {
          const writeTarget = resolveLeafWriteTarget(source, state, path);

          const nodeId =
            writeTarget.existing !== null ? writeTarget.existing.node.id : createNodeId();

          const linkNode: WorktreeNode = {
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

    delete(path: string, options?: { readonly force?: boolean }): void {
      if (options?.force === true) {
        if (path !== VIRTUAL_ROOT_PATH && !resolvePath(source, state, path).found) {
          return;
        }
      }
      const changeIndexPlan = changeIndexPlanner.planDeletePath(path, {
        treatMissingAsIncremental: true,
      });
      runInWriteTransaction(
        state,
        () => {
          changeIndexPlanner.apply(changeIndexPlan);
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

    restore(
      path: string,
      options?: { readonly force?: boolean; readonly recursive?: boolean },
    ): void {
      runInWriteTransaction(
        state,
        () => {
          changeIndexPlanner.apply({ kind: "rebuild-all" });
        },
        invalidateDiffCaches,
        () => {
          restorePathFromBase(source, state, path, options);
        },
      );
    },

    move(from: string, to: string): void {
      runInWriteTransaction(
        state,
        () => {
          changeIndexPlanner.apply(changeIndexPlanner.planMove(from, to));
        },
        invalidateDiffCaches,
        () => {
          assertValidVirtualPath(from);
          assertValidVirtualPath(to);

          if (from === to) {
            return;
          }

          const toParent = parentPath(to);
          if (toParent !== null) {
            mkdirRecursive(toParent);
          }

          const { from: fromTarget, to: toTarget } = resolveWriteTransfer(source, state, from, to);
          const sourceNode = fromTarget.existing.node;

          // 检查目标是否已存在
          if (toTarget.existing !== null) {
            throw new VirtualPathAlreadyExistsError(to);
          }

          // 检查是否将目录移入自身子目录
          if (sourceNode.state.kind === "directory") {
            const toPath = to;
            const fromPath = from;
            if (toPath.startsWith(fromPath + "/") || toPath === fromPath) {
              throw new Error(
                `Cannot move '${from}' to '${to}': destination is a subdirectory of source`,
              );
            }
          }

          const newNodeId = cloneNodeGraphForCopy(source, state, sourceNode, from);
          if (fromTarget.parentNode.id === toTarget.parentNode.id) {
            const nextOverlay = overlayBindEntry(
              overlayTombstoneEntry(fromTarget.parentNode.state.overlay, fromTarget.name),
              toTarget.name,
              newNodeId,
            );
            updateParentOverlay(state, fromTarget.parentNode.id, nextOverlay);
            return;
          }

          updateParentOverlay(
            state,
            fromTarget.parentNode.id,
            overlayTombstoneEntry(fromTarget.parentNode.state.overlay, fromTarget.name),
          );
          updateParentOverlay(
            state,
            toTarget.parentNode.id,
            overlayBindEntry(toTarget.parentNode.state.overlay, toTarget.name, newNodeId),
          );
        },
      );
    },

    copy(from: string, to: string): void {
      runInWriteTransaction(
        state,
        () => {
          changeIndexPlanner.apply(changeIndexPlanner.planCopy(from, to));
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

    diff(): DiffEntry[] {
      return computeVirtualDiff(state);
    },

    writeTree() {
      return writeTreeFromSession(source, state);
    },

    reset(baseTree) {
      runInWriteTransaction(state, null, invalidateDiffCaches, () => {
        state.reset(baseTree);
      });
    },
  };

  return api;
}
