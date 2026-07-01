/**
 * 从 baseTree 恢复 worktree 路径
 */

import { VirtualPathNotFoundError } from "../../errors.ts";
import { originPathNodeId } from "../model/ids.ts";
import { readRepoTree } from "../model/origin.ts";
import { overlayBindEntry, overlayTombstoneEntry } from "../model/overlay.ts";
import {
  assertValidVirtualPath,
  baseName,
  joinPath,
  parentPath,
  splitPathSegments,
  VIRTUAL_ROOT_PATH,
} from "../model/path.ts";
import {
  getDirectoryChildrenView,
  getRootNode,
  requireExistingWriteTarget,
  resolvePath,
} from "./worktree-path.ts";
import { updateParentOverlay } from "./worktree-transaction.ts";

import type { TreeEntry } from "../../types/index.ts";
import type { ObjectSource } from "../../types/odb.ts";
import type { WorktreeNode } from "../model/nodes.ts";
import type { VirtualWorktreeStateStore } from "../store/state-store.ts";

/**
 * 将指定路径恢复为 baseTree 中的状态。
 *
 * @example
 * ```ts
 * restorePathFromBase(source, state, "src/a.ts", { force: false });
 * ```
 */
export function restorePathFromBase(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
  path: string,
  options?: { readonly force?: boolean; readonly recursive?: boolean },
): void {
  const baseEntry = findBaseEntry(source, state, path);
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

  const recursive = options?.recursive === true;
  ensureBaseDirectoryChain(source, state, path);
  const resolvedBeforeRestore = resolvePath(source, state, path);

  if (baseEntry.mode === "040000" && !recursive) {
    if (resolvedBeforeRestore.found) {
      const node = resolvedBeforeRestore.node;
      if (node === null) {
        throw new Error(`Cannot restore '${path}': resolved node is missing`);
      }
      if (node.state.kind === "directory") {
        return;
      }
    }
  }

  const parent = parentPath(path);
  const parentNode = parent === null ? getRootNode(state) : resolvePath(source, state, parent).node;
  if (parentNode === null || parentNode.state.kind !== "directory") {
    throw new Error(`Cannot restore '${path}': parent directory is unavailable`);
  }

  if (
    baseEntry.mode === "040000" &&
    (recursive ||
      !resolvedBeforeRestore.found ||
      resolvedBeforeRestore.node?.state.kind !== "directory")
  ) {
    restoreBaseSubtreeRecursively(source, state, path, baseEntry);
  } else {
    state.setNode(createRestoredNodeFromBaseEntry(path, baseEntry));
  }
  updateParentOverlay(
    state,
    parentNode.id,
    overlayBindEntry(parentNode.state.overlay, baseName(path), originPathNodeId(path)),
  );
}

function findBaseEntry(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
  path: string,
): TreeEntry | null {
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
}

function createRestoredNodeFromBaseEntry(path: string, entry: TreeEntry): WorktreeNode {
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
}

function restoreBaseSubtreeRecursively(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
  path: string,
  entry: TreeEntry,
): void {
  state.setNode(createRestoredNodeFromBaseEntry(path, entry));
  if (entry.mode !== "040000") {
    return;
  }
  const tree = readRepoTree(source, entry.hash, path);
  for (const childEntry of tree.entries) {
    restoreBaseSubtreeRecursively(source, state, joinPath(path, childEntry.name), childEntry);
  }
}

function ensureBaseDirectoryChain(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
  path: string,
): void {
  const segments = splitPathSegments(path);
  let currentPath = VIRTUAL_ROOT_PATH;

  for (let index = 0; index < segments.length - 1; index++) {
    const name = segments[index]!;
    const nextPath = joinPath(currentPath === VIRTUAL_ROOT_PATH ? null : currentPath, name);
    const baseEntry = findBaseEntry(source, state, nextPath);
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
}
