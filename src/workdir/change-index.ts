/**
 * Virtual Workdir 规范化变更索引
 *
 * 第一阶段先完成模型切换：
 * - 对外 `diff()` 改为读取规范化变更索引
 * - 写事务结束前重建净效应表并持久化
 *
 * 当前实现仍复用全量快照算法重建索引，
 * 并将目录本身纳入 diff 视图。
 */

import { hashObject } from "../core/hash.ts";
import { serializeTree } from "../objects/tree.ts";
import { observeListedDirectoryChild } from "./directory-view.ts";
import { readRepoBlobContent, readRepoTree } from "./origin.ts";
import { VIRTUAL_ROOT_PATH } from "./path.ts";
import { getDirectoryChildrenView, joinChildPath, resolvePath } from "./workdir-path.ts";

import type { DiffChanges, DiffEntry, DiffObject, DiffSource } from "../core/diff.ts";
import type { SHA1, TreeEntry } from "../core/types.ts";
import type { ObjectSource } from "../core/types/odb.ts";
import type { NodeId } from "./ids.ts";
import type { WorkdirNode } from "./nodes.ts";
import type { VirtualWorkdirStateStore } from "./state-store.ts";

/**
 * 规范化变更记录
 *
 * 仅保留相对 baseTree 的最终净效应；
 * 若路径已恢复为 clean，则不保存记录。
 */
export interface NormalizedChangeRecord {
  /** 当前路径 */
  readonly path: string;
  /** 变更前对象 */
  readonly previous: DiffObject | null;
  /** 变更后对象 */
  readonly current: DiffObject | null;
  /** move/copy 来源 */
  readonly source: DiffSource | null;
}

interface SnapshotEntry {
  readonly path: string;
  readonly object: DiffObject;
  readonly originSignature: string | null;
}

interface CopySourceMatch {
  readonly path: string;
  readonly entry: SnapshotEntry;
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

/**
 * 重建当前 workdir 的规范化变更索引。
 *
 * @example
 * ```ts
 * const records = rebuildNormalizedChangeIndex(repo.objects, state);
 * expect(records.map((record) => record.path)).toEqual(["hello.txt"]);
 * ```
 */
export function rebuildNormalizedChangeIndex(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  cache?: VirtualDiffComputationCache,
): NormalizedChangeRecord[] {
  const baseSnapshot = baseSnapshotViewForTree(source, state.readBaseTree());
  const baseEntries = baseSnapshot.entries;
  const currentEntries = snapshotCurrentTree(source, state, cache);

  const baseByPath = baseSnapshot.byPath;
  const currentByPath = new Map(currentEntries.map((entry) => [entry.path, entry]));

  const deletes = new Map<string, NormalizedChangeRecord>();
  const adds = new Map<string, NormalizedChangeRecord>();
  const out: NormalizedChangeRecord[] = [];

  const allPaths = new Set<string>([...baseByPath.keys(), ...currentByPath.keys()]);
  for (const path of Array.from(allPaths).sort()) {
    const previous = baseByPath.get(path) ?? null;
    const current = currentByPath.get(path) ?? null;

    if (previous !== null && current !== null) {
      if (!isSameObject(previous.object, current.object)) {
        out.push({
          path,
          previous: previous.object,
          current: current.object,
          source: null,
        });
      }
      continue;
    }

    if (previous !== null) {
      deletes.set(path, {
        path,
        previous: previous.object,
        current: null,
        source: null,
      });
      continue;
    }

    if (current !== null) {
      adds.set(path, {
        path,
        previous: null,
        current: current.object,
        source: null,
      });
    }
  }

  const unmatchedDeletesBySignature = indexDeletesBySignature(deletes);
  const matchedDeletePaths = new Set<string>();

  for (const [path, addRecord] of Array.from(adds.entries()).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const current = currentByPath.get(path);
    if (current === undefined || current.originSignature === null) {
      continue;
    }

    const deleteCandidates = unmatchedDeletesBySignature.get(current.originSignature) ?? [];
    const renameFrom = deleteCandidates.find(
      (candidate) => !matchedDeletePaths.has(candidate.path),
    );
    if (renameFrom !== undefined) {
      matchedDeletePaths.add(renameFrom.path);
      adds.delete(path);
      deletes.delete(renameFrom.path);
      out.push({
        path,
        previous: renameFrom.previous,
        current: addRecord.current,
        source: { kind: "move", path: renameFrom.path },
      });
      continue;
    }

    const copyFrom = findCopySource(baseEntries, current);
    if (copyFrom !== null) {
      adds.delete(path);
      out.push({
        path,
        previous: null,
        current: addRecord.current,
        source: { kind: "copy", path: copyFrom.path },
      });
    }
  }

  out.push(...deletes.values(), ...adds.values());
  return out.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * 将规范化变更索引导出为公开 diff 结果。
 *
 * @example
 * ```ts
 * const diff = exportVirtualDiffFromChangeRecords(records);
 * expect(diff).toHaveLength(1);
 * ```
 */
export function exportVirtualDiffFromChangeRecords(
  records: readonly NormalizedChangeRecord[],
): DiffEntry[] {
  return records
    .map((record) => {
      if (record.previous === null && record.current !== null) {
        return {
          kind: "create",
          path: record.path,
          current: record.current,
          source: record.source ?? undefined,
        } satisfies DiffEntry;
      }

      if (record.previous !== null && record.current === null) {
        return {
          kind: "remove",
          path: record.path,
          previous: record.previous,
        } satisfies DiffEntry;
      }

      if (record.previous !== null && record.current !== null) {
        return {
          kind: "update",
          path: record.path,
          previous: record.previous,
          current: record.current,
          changes: diffChanges(record.previous, record.current),
          source: record.source ?? undefined,
        } satisfies DiffEntry;
      }

      throw new Error(`Invalid normalized change record at path: ${record.path}`);
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * 将新索引完整写回状态存储。
 */
export function replaceChangeRecords(
  state: VirtualWorkdirStateStore,
  records: readonly NormalizedChangeRecord[],
): void {
  const nextByPath = new Map(records.map((record) => [record.path, record]));
  for (const existing of state.listChangeRecords()) {
    if (!nextByPath.has(existing.path)) {
      state.deleteChangeRecord(existing.path);
    }
  }
  for (const record of records) {
    state.setChangeRecord(record);
  }
}

/**
 * 仅刷新单一路径的规范化变更记录。
 *
 * 适用于同路径叶子节点写入等高频场景，
 * 可避免在简单写操作后重建整张索引。
 */
export function refreshChangeRecordForPath(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  path: string,
  cache?: VirtualDiffComputationCache,
): void {
  const previousRecord = state.getChangeRecord(path);
  const nextRecord = computeChangeRecordForPath(source, state, path, previousRecord, cache);
  if (nextRecord === null) {
    state.deleteChangeRecord(path);
    return;
  }
  state.setChangeRecord(nextRecord);
}

/**
 * 将单一路径的变更记录折叠为 move 目标路径。
 *
 * 仅适用于叶子节点 move；
 * 目录及无法判定来源的情况应由调用方回退到全量重建。
 */
export function rewriteChangeRecordForRename(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  from: string,
  to: string,
  cache?: VirtualDiffComputationCache,
): void {
  const previousRecord = state.getChangeRecord(from);
  const currentTarget = snapshotCurrentEntryAtPath(source, state, to, cache);
  if (currentTarget === null) {
    throw new Error(`Cannot rewrite move change record for missing path: ${to}`);
  }

  const nextRecord = computeRenameRecordForPath(
    source,
    state,
    from,
    to,
    previousRecord,
    currentTarget,
  );
  if (nextRecord === null) {
    throw new Error(`Cannot rewrite move change record from '${from}' to '${to}'`);
  }

  state.deleteChangeRecord(from);
  state.setChangeRecord(nextRecord);
}

/**
 * 为 copy 目标路径写入折叠后的变更记录。
 *
 * 仅适用于叶子节点 copy；
 * workdir-only 来源允许退化为普通 create。
 */
export function writeChangeRecordForCopy(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  from: string,
  to: string,
  cache?: VirtualDiffComputationCache,
): void {
  const sourceRecord = state.getChangeRecord(from);
  const currentTarget = snapshotCurrentEntryAtPath(source, state, to, cache);
  if (currentTarget === null) {
    throw new Error(`Cannot write copy change record for missing path: ${to}`);
  }

  state.setChangeRecord({
    path: to,
    previous: null,
    current: currentTarget.object,
    source: deriveCopySource(from, sourceRecord, source, state),
  });
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
  state: VirtualWorkdirStateStore,
  cache?: VirtualDiffComputationCache,
): SnapshotEntry[] {
  const root = state.getNode("root" as WorkdirNode["id"]);
  if (root === null) {
    throw new Error("Virtual workdir is missing root node");
  }
  return snapshotCurrentNode(source, state, root, VIRTUAL_ROOT_PATH, cache);
}

function snapshotCurrentNode(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  node: WorkdirNode,
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
  state: VirtualWorkdirStateStore,
  node: WorkdirNode,
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
  state: VirtualWorkdirStateStore,
  node: WorkdirNode,
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

  throw new Error(`Virtual workdir diff cannot resolve hash for path: ${path}`);
}

function computeChangeRecordForPath(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  path: string,
  previousRecord: NormalizedChangeRecord | null,
  cache?: VirtualDiffComputationCache,
): NormalizedChangeRecord | null {
  const baseEntry = baseSnapshotEntryAtPath(source, state.readBaseTree(), path);
  const currentEntry = snapshotCurrentEntryAtPath(source, state, path, cache);
  const preservedLineage = preserveLineageRecordForPath(path, previousRecord, currentEntry);
  if (preservedLineage !== undefined) {
    return preservedLineage;
  }

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

function computeRenameRecordForPath(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  from: string,
  to: string,
  previousRecord: NormalizedChangeRecord | null,
  currentTarget: SnapshotEntry,
): NormalizedChangeRecord | null {
  const derivedFromPrevious = deriveRenameRecordFromPreviousRecord(
    from,
    to,
    previousRecord,
    currentTarget,
  );
  if (derivedFromPrevious !== undefined) {
    return derivedFromPrevious;
  }

  const baseEntry = baseSnapshotEntryAtPath(source, state.readBaseTree(), from);
  if (baseEntry === null) {
    return null;
  }
  return createNormalizedChangeRecord(
    to,
    baseEntry.object,
    currentTarget.object,
    createDiffSource("move", from),
  );
}

function deriveCopySource(
  from: string,
  sourceRecord: NormalizedChangeRecord | null,
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
): DiffSource | null {
  const fromRecordSource = sourceRecord?.source;
  if (fromRecordSource !== null && fromRecordSource !== undefined) {
    return createDiffSource("copy", fromRecordSource.path);
  }
  if (
    sourceRecord?.previous !== null ||
    baseSnapshotEntryAtPath(source, state.readBaseTree(), from) !== null
  ) {
    return createDiffSource("copy", from);
  }
  return null;
}

function preserveLineageRecordForPath(
  path: string,
  previousRecord: NormalizedChangeRecord | null,
  currentEntry: SnapshotEntry | null,
): NormalizedChangeRecord | null | undefined {
  if (previousRecord?.source?.kind === "move" && previousRecord.previous !== null) {
    if (currentEntry === null) {
      return null;
    }
    return createNormalizedChangeRecord(
      path,
      previousRecord.previous,
      currentEntry.object,
      previousRecord.source,
    );
  }

  if (previousRecord?.source?.kind === "copy") {
    if (currentEntry === null) {
      return null;
    }
    return createNormalizedChangeRecord(path, null, currentEntry.object, previousRecord.source);
  }

  return undefined;
}

function deriveRenameRecordFromPreviousRecord(
  from: string,
  to: string,
  previousRecord: NormalizedChangeRecord | null,
  currentTarget: SnapshotEntry,
): NormalizedChangeRecord | null | undefined {
  if (previousRecord === null) {
    return undefined;
  }
  if (previousRecord.current === null) {
    return null;
  }
  if (previousRecord.source !== null) {
    return createNormalizedChangeRecord(
      to,
      previousRecord.previous,
      currentTarget.object,
      previousRecord.source,
    );
  }
  if (previousRecord.previous === null) {
    return createNormalizedChangeRecord(to, null, currentTarget.object);
  }
  return createNormalizedChangeRecord(
    to,
    previousRecord.previous,
    currentTarget.object,
    createDiffSource("move", from),
  );
}

function snapshotCurrentEntryAtPath(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
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
  state: VirtualWorkdirStateStore,
  leaf: { readonly path: string; readonly node: WorkdirNode },
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
  source: DiffSource | null = null,
): NormalizedChangeRecord {
  return {
    path,
    previous,
    current,
    source,
  };
}

function createDiffSource(kind: "move" | "copy", path: string): DiffSource {
  return { kind, path };
}

function createDiffObject(mode: "100644" | "100755" | "040000" | "120000", hash: SHA1): DiffObject {
  return {
    kind: modeKind(mode),
    mode,
    hash,
  };
}

function diffChanges(previous: DiffObject, current: DiffObject): DiffChanges {
  return {
    kindChanged: previous.kind !== current.kind,
    modeChanged: previous.mode !== current.mode,
    contentChanged: previous.hash !== current.hash,
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

function indexDeletesBySignature(
  deletes: ReadonlyMap<string, NormalizedChangeRecord>,
): ReadonlyMap<string, NormalizedChangeRecord[]> {
  const out = new Map<string, NormalizedChangeRecord[]>();
  for (const entry of deletes.values()) {
    if (entry.previous === null) {
      continue;
    }
    const signature = buildOriginSignature(entry.previous.mode, entry.previous.hash);
    const list = out.get(signature) ?? [];
    list.push(entry);
    out.set(signature, list);
  }
  return out;
}

function findCopySource(
  baseEntries: readonly SnapshotEntry[],
  current: SnapshotEntry,
): CopySourceMatch | null {
  if (current.originSignature === null) {
    return null;
  }

  const source = baseEntries
    .filter((entry) => entry.originSignature === current.originSignature)
    .sort((left, right) => left.path.localeCompare(right.path))[0];
  if (source === undefined) {
    return null;
  }
  return { path: source.path, entry: source };
}

function modeKind(mode: TreeEntry["mode"]): "blob" | "tree" | "symlink" {
  if (mode === "040000") {
    return "tree";
  }
  return mode === "120000" ? "symlink" : "blob";
}

/**
 * 从规范化变更索引导出当前 workdir 的最终 diff。
 *
 * @example
 * ```ts
 * const diff = computeVirtualDiff(state);
 * expect(diff.map((entry) => entry.path)).toEqual(["hello.txt"]);
 * ```
 */
export function computeVirtualDiff(state: VirtualWorkdirStateStore): DiffEntry[] {
  return exportVirtualDiffFromChangeRecords(state.listChangeRecords());
}
