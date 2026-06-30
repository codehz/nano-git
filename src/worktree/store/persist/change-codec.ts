/**
 * 规范化变更记录的持久化编解码
 */

import type { DiffObject } from "../../../core/diff.ts";
import type { SHA1 } from "../../../core/types.ts";
import type { NormalizedChangeRecord } from "../../engine/change-index.ts";

/** 文件 manifest 中的变更记录 */
export interface PersistedChangeRecord {
  readonly path: string;
  readonly previous: DiffObject | null;
  readonly current: DiffObject | null;
}

/** SQLite worktree_changes 行（读侧） */
export interface SqliteChangeRow {
  readonly path: string;
  readonly previous_kind: string | null;
  readonly previous_mode: string | null;
  readonly previous_hash: string | null;
  readonly current_kind: string | null;
  readonly current_mode: string | null;
  readonly current_hash: string | null;
}

/**
 * manifest 记录 -> 内存记录。
 */
export function parseChangeRecordFromManifest(
  record: PersistedChangeRecord,
): NormalizedChangeRecord {
  return {
    path: record.path,
    previous:
      record.previous === null ? null : { ...record.previous, hash: record.previous.hash as SHA1 },
    current:
      record.current === null ? null : { ...record.current, hash: record.current.hash as SHA1 },
  };
}

/**
 * 内存记录 -> manifest 记录。
 */
export function serializeChangeRecordToManifest(
  record: NormalizedChangeRecord,
): PersistedChangeRecord {
  return {
    path: record.path,
    previous: record.previous,
    current: record.current,
  };
}

/**
 * SQLite 行 -> 内存记录。
 */
export function parseChangeRecordFromSqlite(row: SqliteChangeRow): NormalizedChangeRecord {
  return {
    path: row.path,
    previous:
      row.previous_kind === null || row.previous_mode === null || row.previous_hash === null
        ? null
        : {
            kind: readDiffObjectKind(row.previous_kind),
            mode: readDiffObjectMode(row.previous_mode),
            hash: row.previous_hash as SHA1,
          },
    current:
      row.current_kind === null || row.current_mode === null || row.current_hash === null
        ? null
        : {
            kind: readDiffObjectKind(row.current_kind),
            mode: readDiffObjectMode(row.current_mode),
            hash: row.current_hash as SHA1,
          },
  };
}

function readDiffObjectKind(raw: string): "blob" | "tree" | "symlink" {
  if (raw === "blob" || raw === "tree" || raw === "symlink") {
    return raw;
  }
  throw new Error(`Invalid worktree diff object kind: ${raw}`);
}

function readDiffObjectMode(raw: string): "100644" | "100755" | "040000" | "120000" {
  if (raw === "100644" || raw === "100755" || raw === "040000" || raw === "120000") {
    return raw;
  }
  throw new Error(`Invalid worktree diff object mode: ${raw}`);
}
