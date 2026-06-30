/**
 * Virtual Worktree 规范化变更索引
 *
 * 基于 baseTree 与当前 worktree 快照计算最终净效应，
 * 并将目录本身纳入 diff 视图。
 */

import {
  computeChangeRecordForPath,
  getBaseSnapshotView,
  isSameDiffObject,
  listCurrentSnapshotEntries,
} from "./change-snapshot.ts";

import type { DiffChanges, DiffEntry, DiffObject } from "../../core/diff.ts";
import type { ObjectSource } from "../../core/types/odb.ts";
import type { VirtualWorktreeStateStore } from "../store/state-store.ts";
import type { VirtualDiffComputationCache } from "./change-snapshot.ts";

export type { VirtualDiffComputationCache } from "./change-snapshot.ts";

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
}

/**
 * 重建当前 worktree 的规范化变更索引。
 *
 * @example
 * ```ts
 * const records = rebuildNormalizedChangeIndex(repo.objects, state);
 * expect(records.map((record) => record.path)).toEqual(["hello.txt"]);
 * ```
 */
export function rebuildNormalizedChangeIndex(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
  cache?: VirtualDiffComputationCache,
): NormalizedChangeRecord[] {
  const baseSnapshot = getBaseSnapshotView(source, state.readBaseTree());
  const currentEntries = listCurrentSnapshotEntries(source, state, cache);

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
      if (!isSameDiffObject(previous.object, current.object)) {
        out.push({
          path,
          previous: previous.object,
          current: current.object,
        });
      }
      continue;
    }

    if (previous !== null) {
      deletes.set(path, {
        path,
        previous: previous.object,
        current: null,
      });
      continue;
    }

    if (current !== null) {
      adds.set(path, {
        path,
        previous: null,
        current: current.object,
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
  state: VirtualWorktreeStateStore,
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
  state: VirtualWorktreeStateStore,
  path: string,
  cache?: VirtualDiffComputationCache,
): void {
  const nextRecord = computeChangeRecordForPath(source, state, path, cache);
  if (nextRecord === null) {
    state.deleteChangeRecord(path);
    return;
  }
  state.setChangeRecord(nextRecord);
}

function diffChanges(previous: DiffObject, current: DiffObject): DiffChanges {
  return {
    kindChanged: previous.kind !== current.kind,
    modeChanged: previous.mode !== current.mode,
    contentChanged: previous.hash !== current.hash,
  };
}

/**
 * 从规范化变更索引导出当前 worktree 的最终 diff。
 *
 * @example
 * ```ts
 * const diff = computeVirtualDiff(state);
 * expect(diff.map((entry) => entry.path)).toEqual(["hello.txt"]);
 * ```
 */
export function computeVirtualDiff(state: VirtualWorktreeStateStore): DiffEntry[] {
  return exportVirtualDiffFromChangeRecords(state.listChangeRecords());
}
