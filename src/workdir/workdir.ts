/**
 * VirtualWorkdir 行为编排
 *
 * 负责组装 VirtualWorkdir 的读写、结构变更与导出行为。
 */

import {
  VirtualNotDirectoryError,
  VirtualNotFileError,
  VirtualNotSymlinkError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
} from "../core/errors.ts";
import { createChangeIndexPlanner } from "./change-index-plan.ts";
import { rebuildNormalizedChangeIndex, replaceChangeRecords } from "./change-index.ts";
import { computeVirtualDiff } from "./change-index.ts";
import { createNodeId, originPathNodeId } from "./ids.ts";
import { createVirtualWorkdirMemoryStateStore } from "./memory-backend.ts";
import { type WorkdirNode } from "./nodes.ts";
import { modeToVirtualEntryKind, readRepoBlobContent, readRepoTree } from "./origin.ts";
import { overlayBindEntry, overlayTombstoneEntry } from "./overlay.ts";
import {
  assertValidVirtualPath,
  baseName,
  joinPath,
  normalizeDirectoryPath,
  parentPath,
  splitPathSegments,
  VIRTUAL_ROOT_PATH,
} from "./path.ts";
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

import type { DiffEntry } from "../core/diff.ts";
import type { SHA1 } from "../core/types.ts";
import type { TreeEntry } from "../core/types.ts";
import type { ObjectDatabase } from "../core/types/odb.ts";
import type {
  CreateVirtualWorkdirOptions,
  VirtualDirEntry,
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
  const changeIndexPlanner = createChangeIndexPlanner(source, state, {
    rebuildAll: refreshChangeIndex,
    refreshPath: refreshChangeIndex,
  });
  refreshChangeIndex();

  const createDirectoryAtPath = (path: string): void => {
    const target = requireMissingWriteTarget(source, state, path);
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

  const findBaseEntry = (path: string): TreeEntry | null => {
    assertValidVirtualPath(path);
    let treeHash = state.readBaseTree();
    const segments = splitPathSegments(path);

    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!;
      const currentPath = segments.slice(0, index + 1).join("/");
      const tree = readRepoTree(source, treeHash, index === 0 ? VIRTUAL_ROOT_PATH : currentPath);
      const entry = tree.entries.find((candidate) => candidate.name === segment) ?? null;
      if (entry === null) {
        return null;
      }
      if (index === segments.length - 1) {
        return entry;
      }
      if (entry.mode !== "040000") {
        return null;
      }
      treeHash = entry.hash;
    }

    return null;
  };

  const createRestoredNodeFromBaseEntry = (path: string, entry: TreeEntry): WorkdirNode => {
    const id = originPathNodeId(path);
    if (entry.mode === "040000") {
      return {
        id,
        origin: { kind: "repo-tree", hash: entry.hash },
        state: {
          kind: "directory",
          overlay: { addedEntries: new Map(), deletedNames: new Set() },
        },
      };
    }
    if (entry.mode === "120000") {
      return {
        id,
        origin: { kind: "repo-blob", mode: "120000", hash: entry.hash },
        state: { kind: "symlink", mode: "120000" },
      };
    }
    return {
      id,
      origin: {
        kind: "repo-blob",
        mode: entry.mode === "100755" ? "100755" : "100644",
        hash: entry.hash,
      },
      state: {
        kind: "file",
        mode: entry.mode === "100755" ? "100755" : "100644",
      },
    };
  };

  const ensureBaseDirectoryChain = (path: string): void => {
    const segments = splitPathSegments(path);
    let currentPath = VIRTUAL_ROOT_PATH;

    for (let index = 0; index < segments.length - 1; index++) {
      const name = segments[index]!;
      const nextPath = joinPath(currentPath === VIRTUAL_ROOT_PATH ? null : currentPath, name);
      const baseEntry = findBaseEntry(nextPath);
      if (baseEntry === null || baseEntry.mode !== "040000") {
        throw new Error(
          `Cannot restore '${path}': base parent directory is missing at '${nextPath}'`,
        );
      }

      const currentNode =
        currentPath === VIRTUAL_ROOT_PATH
          ? getRootNode(state)
          : resolvePath(source, state, currentPath).node;
      if (currentNode === null || currentNode.state.kind !== "directory") {
        throw new Error(
          `Cannot restore '${path}': parent directory is not available at '${currentPath}'`,
        );
      }

      const existing = getDirectoryChildrenView(source, state, currentNode, currentPath).get(name);
      if (existing !== undefined) {
        const existingNode = state.getNode(existing.nodeId);
        if (existingNode === null) {
          throw new Error(`Cannot restore '${path}': child node is missing at '${nextPath}'`);
        }
        if (existingNode.state.kind !== "directory") {
          state.setNode(createRestoredNodeFromBaseEntry(nextPath, baseEntry));
          updateParentOverlay(
            state,
            currentNode.id,
            overlayBindEntry(currentNode.state.overlay, name, originPathNodeId(nextPath)),
          );
        }
      } else {
        state.setNode(createRestoredNodeFromBaseEntry(nextPath, baseEntry));
        updateParentOverlay(
          state,
          currentNode.id,
          overlayBindEntry(currentNode.state.overlay, name, originPathNodeId(nextPath)),
        );
      }

      currentPath = nextPath;
    }
  };

  const restorePathFromBase = (path: string, options?: { readonly force?: boolean }): void => {
    const baseEntry = findBaseEntry(path);
    if (baseEntry === null) {
      if (options?.force === true) {
        const resolved = resolvePath(source, state, path);
        if (!resolved.found) {
          return;
        }
        const target = requireExistingWriteTarget(source, state, path);
        updateParentOverlay(
          state,
          target.parentNode.id,
          overlayTombstoneEntry(target.parentNode.state.overlay, target.name),
        );
        return;
      }
      throw new VirtualPathNotFoundError(
        path,
        `Cannot restore '${path}': path does not exist in baseTree`,
      );
    }

    ensureBaseDirectoryChain(path);
    const parent = parentPath(path);
    const parentNode =
      parent === null ? getRootNode(state) : resolvePath(source, state, parent).node;
    if (parentNode === null || parentNode.state.kind !== "directory") {
      throw new Error(`Cannot restore '${path}': parent directory is unavailable`);
    }

    const restoredNode = createRestoredNodeFromBaseEntry(path, baseEntry);
    state.setNode(restoredNode);
    updateParentOverlay(
      state,
      parentNode.id,
      overlayBindEntry(parentNode.state.overlay, baseName(path), restoredNode.id),
    );
  };

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

    restore(path: string, options?: { readonly force?: boolean }): void {
      runInWriteTransaction(
        state,
        () => {
          changeIndexPlanner.apply({ kind: "rebuild-all" });
        },
        invalidateDiffCaches,
        () => {
          restorePathFromBase(path, options);
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
