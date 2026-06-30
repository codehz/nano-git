/**
 * Virtual Worktree baseTree / 当前树快照
 *
 * 将仓库 baseTree 与内存 worktree 状态物化为按路径索引的 DiffObject 视图，
 * 供 change-index 计算规范化变更记录。
 */

import { hashObject } from "../../core/hash.ts";
import { serializeTree } from "../../objects/tree.ts";
import { readRepoBlobContent, readRepoTree } from "../model/origin.ts";
import { VIRTUAL_ROOT_PATH } from "../model/path.ts";
import { observeListedDirectoryChild } from "./directory-view.ts";
import { getDirectoryChildrenView, joinChildPath, resolvePath } from "./worktree-path.ts";

import type { DiffObject } from "../../core/diff.ts";
import type { SHA1, TreeEntry } from "../../core/types.ts";
import type { ObjectSource } from "../../core/types/odb.ts";
import type { NodeId } from "../model/ids.ts";
import type { WorktreeNode } from "../model/nodes.ts";
import type { VirtualWorktreeStateStore } from "../store/state-store.ts";

interface SnapshotEntry {
  readonly path: string;
  readonly object: DiffObject;
  readonly originSignature: string | null;
}

interface BaseSnapshotView {
  readonly entries: readonly SnapshotEntry[];
  readonly byPath: ReadonlyMap<string, SnapshotEntry>;
}

export interface VirtualDiffComputationCache {
  readonly currentNodeHashes: ReadonlyMap<NodeId, SHA1>;
  setCurrentNodeHash(nodeId: NodeId, hash: SHA1): void;
}

const baseSnapshotCache = new WeakMap<ObjectSource, Map<SHA1, BaseSnapshotView>>();

interface PathChangeDelta {
  readonly path: string;
  readonly previous: DiffObject | null;
  readonly current: DiffObject | null;
}

/**
 * 读取 baseTree 的快照视图（按路径索引）。
 */
export function getBaseSnapshotView(source: ObjectSource, treeHash: SHA1): BaseSnapshotView {
  return baseSnapshotViewForTree(source, treeHash);
}

/**
 * 收集当前 worktree 全树快照条目。
 */
export function listCurrentSnapshotEntries(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
  cache?: VirtualDiffComputationCache,
): readonly SnapshotEntry[] {
  return snapshotCurrentTree(source, state, cache);
}

/**
 * 比较两个 DiffObject 是否一致。
 */
export function isSameDiffObject(previous: DiffObject, current: DiffObject): boolean {
  return isSameObject(previous, current);
}

/**
 * 计算单一路径相对 baseTree 的净变更；无变更时返回 null。
 */
export function computeChangeRecordForPath(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
  path: string,
  cache?: VirtualDiffComputationCache,
): PathChangeDelta | null {
  return computeChangeRecordForPathImpl(source, state, path, cache);
}

function snapshotBaseTree(source: ObjectSource, treeHash: SHA1, dirPath: string): SnapshotEntry[] {
  if (dirPath === VIRTUAL_ROOT_PATH) {
    const cached = getCachedBaseSnapshot(source, treeHash);
    if (cached !== null) {
      return [...cached.entries];
    }
  }

  const tree = readRepoTree(source, treeHash, dirPath);
  const out: SnapshotEntry[] = [];

  for (const entry of tree.entries) {
    const path = joinChildPath(dirPath, entry.name);
    if (entry.mode === "040000") {
      out.push({
        path,
        object: createDiffObject("040000", entry.hash),
        originSignature: buildOriginSignature("040000", entry.hash),
      });
      out.push(...snapshotBaseTree(source, entry.hash, path));
      continue;
    }

    const object = createDiffObject(normalizeBlobMode(entry.mode), entry.hash);
    out.push({
      path,
      object,
      originSignature: buildOriginSignature(object.mode, object.hash),
    });
  }

  if (dirPath === VIRTUAL_ROOT_PATH) {
    setCachedBaseSnapshot(source, treeHash, createBaseSnapshotView(out));
  }

  return out;
}

function baseSnapshotViewForTree(source: ObjectSource, treeHash: SHA1): BaseSnapshotView {
  const cached = getCachedBaseSnapshot(source, treeHash);
  if (cached !== null) {
    return cached;
  }

  const entries = snapshotBaseTree(source, treeHash, VIRTUAL_ROOT_PATH);
  const view = createBaseSnapshotView(entries);
  setCachedBaseSnapshot(source, treeHash, view);
  return view;
}

function snapshotCurrentTree(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
  cache?: VirtualDiffComputationCache,
): SnapshotEntry[] {
  const root = state.getNode("root" as WorktreeNode["id"]);
  if (root === null) {
    throw new Error("Virtual worktree is missing root node");
  }
  return snapshotCurrentNode(source, state, root, VIRTUAL_ROOT_PATH, cache);
}

function snapshotCurrentNode(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
  node: WorktreeNode,
  path: string,
  cache?: VirtualDiffComputationCache,
): SnapshotEntry[] {
  if (node.state.kind === "directory") {
    const out: SnapshotEntry[] = [];
    if (path !== VIRTUAL_ROOT_PATH) {
      out.push(snapshotCurrentDirectoryNode(source, state, node, path, cache));
    }
    for (const child of getDirectoryChildrenView(source, state, node, path).children) {
      const observedChild = observeListedDirectoryChild(state, path, child);
      if (observedChild === null) {
        continue;
      }
      out.push(
        ...snapshotCurrentNode(source, state, observedChild.node, observedChild.path, cache),
      );
    }
    return out;
  }

  return [snapshotCurrentLeafNode(source, state, { path, node }, cache)];
}

function snapshotCurrentDirectoryNode(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
  node: WorktreeNode,
  path: string,
  cache?: VirtualDiffComputationCache,
): SnapshotEntry {
  const hash = currentNodeHash(source, state, node, path, cache);
  return {
    path,
    object: createDiffObject("040000", hash),
    originSignature:
      node.origin.kind === "repo-tree" ? buildOriginSignature("040000", node.origin.hash) : null,
  };
}

function currentNodeHash(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
  node: WorktreeNode,
  path: string,
  cache?: VirtualDiffComputationCache,
): SHA1 {
  if (node.state.kind === "directory") {
    const cached = cache?.currentNodeHashes.get(node.id);
    if (cached !== undefined) {
      return cached;
    }
    if (
      node.origin.kind === "repo-tree" &&
      node.state.overlay.addedEntries.size === 0 &&
      node.state.overlay.deletedNames.size === 0
    ) {
      cache?.setCurrentNodeHash(node.id, node.origin.hash);
      return node.origin.hash;
    }

    const entries: TreeEntry[] = [];
    for (const child of getDirectoryChildrenView(source, state, node, path).children) {
      const observedChild = observeListedDirectoryChild(state, path, child);
      if (observedChild === null) {
        continue;
      }
      entries.push({
        mode:
          observedChild.node.state.kind === "directory" ? "040000" : observedChild.node.state.mode,
        name: observedChild.name,
        hash: currentNodeHash(source, state, observedChild.node, observedChild.path, cache),
      });
    }
    const hash = hashObject("tree", serializeTree({ type: "tree", entries }));
    cache?.setCurrentNodeHash(node.id, hash);
    return hash;
  }

  if (node.state.kind === "file") {
    if (node.state.content !== undefined) {
      const cached = cache?.currentNodeHashes.get(node.id);
      if (cached !== undefined) {
        return cached;
      }
      const hash = hashObject("blob", node.state.content);
      cache?.setCurrentNodeHash(node.id, hash);
      return hash;
    }
    if (node.origin.kind === "repo-blob") {
      return node.origin.hash;
    }
  }

  if (node.state.kind === "symlink") {
    if (node.state.target !== undefined) {
      const cached = cache?.currentNodeHashes.get(node.id);
      if (cached !== undefined) {
        return cached;
      }
      const hash = hashObject("blob", node.state.target);
      cache?.setCurrentNodeHash(node.id, hash);
      return hash;
    }
    if (node.origin.kind === "repo-blob") {
      return node.origin.hash;
    }
  }

  if (node.origin.kind === "repo-blob") {
    const content = readRepoBlobContent(source, node.origin.hash, path);
    return hashObject("blob", content);
  }

  throw new Error(`Virtual worktree diff cannot resolve hash for path: ${path}`);
}

function computeChangeRecordForPathImpl(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
  path: string,
  cache?: VirtualDiffComputationCache,
): PathChangeDelta | null {
  const baseEntry = baseSnapshotEntryAtPath(source, state.readBaseTree(), path);
  const currentEntry = snapshotCurrentEntryAtPath(source, state, path, cache);

  if (baseEntry === null && currentEntry === null) {
    return null;
  }

  if (baseEntry === null && currentEntry !== null) {
    return createNormalizedChangeRecord(path, null, currentEntry.object);
  }

  if (baseEntry !== null && currentEntry === null) {
    return createNormalizedChangeRecord(path, baseEntry.object, null);
  }

  if (baseEntry !== null && currentEntry !== null) {
    if (isSameObject(baseEntry.object, currentEntry.object)) {
      return null;
    }
    return createNormalizedChangeRecord(path, baseEntry.object, currentEntry.object);
  }

  throw new Error(`Unreachable change-record state at path: ${path}`);
}

function snapshotCurrentEntryAtPath(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
  path: string,
  cache?: VirtualDiffComputationCache,
): SnapshotEntry | null {
  const resolved = resolvePath(source, state, path);
  if (!resolved.found || resolved.node === null) {
    return null;
  }
  if (resolved.node.state.kind === "directory") {
    return snapshotCurrentDirectoryNode(source, state, resolved.node, path, cache);
  }
  return snapshotCurrentLeafNode(source, state, { path, node: resolved.node }, cache);
}

function snapshotCurrentLeafNode(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
  leaf: { readonly path: string; readonly node: WorktreeNode },
  cache?: VirtualDiffComputationCache,
): SnapshotEntry {
  if (leaf.node.state.kind === "directory") {
    throw new Error(`snapshotCurrentLeafNode called on directory: ${leaf.path}`);
  }
  const hash = currentNodeHash(source, state, leaf.node, leaf.path, cache);
  const object = createDiffObject(leaf.node.state.mode, hash);
  return {
    path: leaf.path,
    object,
    originSignature:
      leaf.node.origin.kind === "repo-blob"
        ? buildOriginSignature(leaf.node.origin.mode, leaf.node.origin.hash)
        : null,
  };
}

function createNormalizedChangeRecord(
  path: string,
  previous: DiffObject | null,
  current: DiffObject | null,
): PathChangeDelta {
  return {
    path,
    previous,
    current,
  };
}

function createDiffObject(mode: "100644" | "100755" | "040000" | "120000", hash: SHA1): DiffObject {
  return {
    kind: modeKind(mode),
    mode,
    hash,
  };
}

function isSameObject(previous: DiffObject, current: DiffObject): boolean {
  return (
    previous.kind === current.kind &&
    previous.mode === current.mode &&
    previous.hash === current.hash
  );
}

function normalizeBlobMode(mode: string): "100644" | "100755" | "120000" {
  if (mode === "100755" || mode === "120000") {
    return mode;
  }
  return "100644";
}

function buildOriginSignature(mode: "100644" | "100755" | "040000" | "120000", hash: SHA1): string {
  return `${mode}:${hash}`;
}

function getCachedBaseSnapshot(source: ObjectSource, treeHash: SHA1): BaseSnapshotView | null {
  return baseSnapshotCache.get(source)?.get(treeHash) ?? null;
}

function setCachedBaseSnapshot(source: ObjectSource, treeHash: SHA1, view: BaseSnapshotView): void {
  const cache = baseSnapshotCache.get(source) ?? new Map<SHA1, BaseSnapshotView>();
  cache.set(treeHash, view);
  baseSnapshotCache.set(source, cache);
}

function createBaseSnapshotView(entries: readonly SnapshotEntry[]): BaseSnapshotView {
  return {
    entries,
    byPath: new Map(entries.map((entry) => [entry.path, entry])),
  };
}

function baseSnapshotEntryAtPath(
  source: ObjectSource,
  treeHash: SHA1,
  path: string,
): SnapshotEntry | null {
  return baseSnapshotViewForTree(source, treeHash).byPath.get(path) ?? null;
}

function modeKind(mode: TreeEntry["mode"]): "blob" | "tree" | "symlink" {
  if (mode === "040000") {
    return "tree";
  }
  return mode === "120000" ? "symlink" : "blob";
}
