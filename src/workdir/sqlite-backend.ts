/**
 * Virtual Workdir SQLite backend
 */

import { acquireConnection, type SqliteConnectionHandle } from "../backend/sqlite-pool.ts";
import { sha1 } from "../core/types.ts";
import { createRootDirectoryNode, type WorkdirNode } from "./nodes.ts";
import { openVirtualWorkdir } from "./workdir.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectDatabase } from "../core/types/odb.ts";
import type { NormalizedChangeRecord } from "./change-index.ts";
import type { CreateVirtualWorkdirOptions, VirtualWorkdir } from "./core.ts";
import type { DirtyDirHashState, DirtyDirSummary } from "./dirty-dir.ts";
import type { NodeId } from "./ids.ts";
import type { DirectoryOverlay } from "./overlay.ts";
import type { VirtualWorkdirStateStore } from "./state-store.ts";
import type { Database } from "bun:sqlite";

/** SQLite 连接层的可选参数 */
export interface SqliteVirtualWorkdirConnectionOptions {
  /** 开启 WAL 模式，默认 true */
  readonly walMode?: boolean;
}

/** 打开 SQLite VirtualWorkdir 的可选参数 */
export interface OpenSqliteVirtualWorkdirOptions
  extends CreateVirtualWorkdirOptions, SqliteVirtualWorkdirConnectionOptions {
  /** 不存在时按 baseTree 初始化 */
  readonly create?: boolean;
}

/**
 * 基于 SQLite 的 VirtualWorkdir
 *
 * 返回值附带 `[Symbol.dispose]()`，用于释放内部数据库连接。
 */
export type SqliteVirtualWorkdir = VirtualWorkdir & { [Symbol.dispose](): void };

const WORKDIR_SQLITE_SCHEMA_VERSION = 6;

interface WorkdirRow {
  workdir_key: string;
  base_tree: string;
}

interface NodeRow {
  node_id: string;
  origin_kind: string;
  origin_hash: string | null;
  origin_mode: string | null;
  state_kind: string;
  state_mode: string | null;
  content: Uint8Array | null;
  target: Uint8Array | null;
  directory_overlay: string | null;
}

interface ChangeRow {
  path: string;
  previous_kind: string | null;
  previous_mode: string | null;
  previous_hash: string | null;
  current_kind: string | null;
  current_mode: string | null;
  current_hash: string | null;
  source_kind: string | null;
  source_path: string | null;
}

interface DirtyDirRow {
  path: string;
  is_dirty: number;
  dirty_entry_count: number;
  dirty_descendant_count: number;
  affected_names: string;
  current_tree_hash: string | null;
  hash_state: string;
}

/**
 * 打开基于 SQLite 的持久化 VirtualWorkdir
 *
 * @example
 * ```ts
 * using workdir = openSqliteVirtualWorkdir(repo.objects, ":memory:", "demo", {
 *   baseTree: tree,
 *   create: true,
 * });
 * expect(workdir.baseTree).toBe(tree);
 * ```
 */
export function openSqliteVirtualWorkdir(
  source: ObjectDatabase,
  dbPath: string,
  workdirKey: string,
  options: OpenSqliteVirtualWorkdirOptions,
): SqliteVirtualWorkdir {
  const conn = acquireConnection(dbPath, options.walMode !== false);
  try {
    ensureSchema(conn.db);
    const store = createSqliteVirtualWorkdirStateStore(conn, workdirKey);
    if (!hasWorkdir(conn.db, workdirKey)) {
      if (options.create !== true) {
        throw new Error(`Virtual workdir not found: ${workdirKey}`);
      }
      store.reset(options.baseTree);
    }
    validateWorkdirIntegrity(conn.db, workdirKey);

    let released = false;
    const workdir = openVirtualWorkdir(source, store);
    return Object.assign(workdir, {
      [Symbol.dispose](): void {
        if (released) {
          return;
        }
        released = true;
        conn.release();
      },
    });
  } catch (error) {
    conn.release();
    throw error;
  }
}

/**
 * 删除指定 key 上的 SQLite VirtualWorkdir
 *
 * @example
 * ```ts
 * deleteSqliteVirtualWorkdir("/tmp/workdir.sqlite", "demo");
 * ```
 */
export function deleteSqliteVirtualWorkdir(
  dbPath: string,
  workdirKey: string,
  options: SqliteVirtualWorkdirConnectionOptions = {},
): void {
  const conn = acquireConnection(dbPath, options.walMode !== false);
  try {
    ensureSchema(conn.db);
    if (!hasWorkdir(conn.db, workdirKey)) {
      throw new Error(`Virtual workdir not found: ${workdirKey}`);
    }
    deleteWorkdirRows(conn.db, workdirKey);
  } finally {
    conn.release();
  }
}

/**
 * 创建单个 SQLite VirtualWorkdir 的状态存储
 *
 * @example
 * ```ts
 * using conn = acquireConnection("/tmp/workdir.sqlite");
 * const store = createSqliteVirtualWorkdirStateStore(conn, "demo");
 * expect(store.kind).toBe("sqlite");
 * ```
 */
export function createSqliteVirtualWorkdirStateStore(
  conn: SqliteConnectionHandle,
  workdirKey: string,
): VirtualWorkdirStateStore {
  const transactImpl = conn.db.transaction((fn: () => unknown) => fn());
  const readBaseTreeStmt = conn.prepare<Pick<WorkdirRow, "base_tree"> | null>(
    "SELECT base_tree FROM workdirs WHERE workdir_key = ?",
  );
  const upsertWorkdirStmt = conn.prepare<void>(
    "INSERT INTO workdirs (workdir_key, base_tree) VALUES (?, ?) ON CONFLICT(workdir_key) DO UPDATE SET base_tree = excluded.base_tree",
  );
  const getNodeStmt = conn.prepare<NodeRow | null>(
    `SELECT node_id, origin_kind, origin_hash, origin_mode, state_kind, state_mode, content, target, directory_overlay
     FROM workdir_nodes
     WHERE workdir_key = ? AND node_id = ?`,
  );
  const setNodeStmt = conn.prepare<void>(
    `INSERT INTO workdir_nodes (
        workdir_key, node_id, origin_kind, origin_hash, origin_mode,
        state_kind, state_mode, content, target, directory_overlay
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workdir_key, node_id) DO UPDATE SET
        origin_kind = excluded.origin_kind,
        origin_hash = excluded.origin_hash,
        origin_mode = excluded.origin_mode,
        state_kind = excluded.state_kind,
        state_mode = excluded.state_mode,
        content = excluded.content,
        target = excluded.target,
        directory_overlay = excluded.directory_overlay`,
  );
  const deleteNodeStmt = conn.prepare<void>(
    "DELETE FROM workdir_nodes WHERE workdir_key = ? AND node_id = ?",
  );
  const clearNodesStmt = conn.prepare<void>("DELETE FROM workdir_nodes WHERE workdir_key = ?");
  const listChangesStmt = conn.prepare<ChangeRow>(
    `SELECT path, previous_kind, previous_mode, previous_hash, current_kind, current_mode, current_hash, source_kind, source_path
     FROM workdir_changes
     WHERE workdir_key = ?
     ORDER BY path`,
  );
  const getChangeStmt = conn.prepare<ChangeRow | null>(
    `SELECT path, previous_kind, previous_mode, previous_hash, current_kind, current_mode, current_hash, source_kind, source_path
     FROM workdir_changes
     WHERE workdir_key = ? AND path = ?`,
  );
  const upsertChangeStmt = conn.prepare<void>(
    `INSERT INTO workdir_changes (
      workdir_key, path, previous_kind, previous_mode, previous_hash,
      current_kind, current_mode, current_hash, source_kind, source_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workdir_key, path) DO UPDATE SET
      previous_kind = excluded.previous_kind,
      previous_mode = excluded.previous_mode,
      previous_hash = excluded.previous_hash,
      current_kind = excluded.current_kind,
      current_mode = excluded.current_mode,
      current_hash = excluded.current_hash,
      source_kind = excluded.source_kind,
      source_path = excluded.source_path`,
  );
  const deleteChangeStmt = conn.prepare<void>(
    "DELETE FROM workdir_changes WHERE workdir_key = ? AND path = ?",
  );
  const clearChangesStmt = conn.prepare<void>("DELETE FROM workdir_changes WHERE workdir_key = ?");
  const listDirtyDirsStmt = conn.prepare<DirtyDirRow>(
    `SELECT path, is_dirty, dirty_entry_count, dirty_descendant_count, affected_names, current_tree_hash, hash_state
     FROM workdir_dirty_dirs
     WHERE workdir_key = ?
     ORDER BY path`,
  );
  const getDirtyDirStmt = conn.prepare<DirtyDirRow | null>(
    `SELECT path, is_dirty, dirty_entry_count, dirty_descendant_count, affected_names, current_tree_hash, hash_state
     FROM workdir_dirty_dirs
     WHERE workdir_key = ? AND path = ?`,
  );
  const upsertDirtyDirStmt = conn.prepare<void>(
    `INSERT INTO workdir_dirty_dirs (
      workdir_key, path, is_dirty, dirty_entry_count, dirty_descendant_count,
      affected_names, current_tree_hash, hash_state
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workdir_key, path) DO UPDATE SET
       is_dirty = excluded.is_dirty,
       dirty_entry_count = excluded.dirty_entry_count,
       dirty_descendant_count = excluded.dirty_descendant_count,
       affected_names = excluded.affected_names,
       current_tree_hash = excluded.current_tree_hash,
       hash_state = excluded.hash_state`,
  );
  const deleteDirtyDirStmt = conn.prepare<void>(
    "DELETE FROM workdir_dirty_dirs WHERE workdir_key = ? AND path = ?",
  );
  const clearDirtyDirsStmt = conn.prepare<void>(
    "DELETE FROM workdir_dirty_dirs WHERE workdir_key = ?",
  );

  const resetTx = conn.db.transaction((baseTree: SHA1) => {
    upsertWorkdirStmt.run(workdirKey, baseTree);
    clearNodesStmt.run(workdirKey);
    clearChangesStmt.run(workdirKey);
    clearDirtyDirsStmt.run(workdirKey);
    writeNode(setNodeStmt, workdirKey, createRootDirectoryNode(baseTree));
  });

  return {
    kind: "sqlite",

    transact<T>(fn: () => T): T {
      return transactImpl(fn) as T;
    },

    readBaseTree(): SHA1 {
      const row = readBaseTreeStmt.get(workdirKey);
      if (row === null) {
        throw new Error(`Virtual workdir not found: ${workdirKey}`);
      }
      return readBaseTreeValue(row.base_tree);
    },

    writeBaseTree(baseTree: SHA1): void {
      upsertWorkdirStmt.run(workdirKey, baseTree);
    },

    getNode(id: NodeId): WorkdirNode | null {
      const row = getNodeStmt.get(workdirKey, id);
      if (row === null) {
        return null;
      }
      return readNode(row);
    },

    setNode(node: WorkdirNode): void {
      writeNode(setNodeStmt, workdirKey, node);
    },

    deleteNode(id: NodeId): void {
      deleteNodeStmt.run(workdirKey, id);
    },

    listChangeRecords(): readonly NormalizedChangeRecord[] {
      return listChangesStmt.all(workdirKey).map(readChangeRecord);
    },

    getChangeRecord(path: string): NormalizedChangeRecord | null {
      const row = getChangeStmt.get(workdirKey, path);
      return row === null ? null : readChangeRecord(row);
    },

    setChangeRecord(record: NormalizedChangeRecord): void {
      upsertChangeStmt.run(
        workdirKey,
        record.path,
        record.previous?.kind ?? null,
        record.previous?.mode ?? null,
        record.previous?.hash ?? null,
        record.current?.kind ?? null,
        record.current?.mode ?? null,
        record.current?.hash ?? null,
        record.source?.kind ?? null,
        record.source?.path ?? null,
      );
    },

    deleteChangeRecord(path: string): void {
      deleteChangeStmt.run(workdirKey, path);
    },

    listDirtyDirSummaries(): readonly DirtyDirSummary[] {
      return listDirtyDirsStmt.all(workdirKey).map(readDirtyDirSummary);
    },

    getDirtyDirSummary(path: string): DirtyDirSummary | null {
      const row = getDirtyDirStmt.get(workdirKey, path);
      return row === null ? null : readDirtyDirSummary(row);
    },

    setDirtyDirSummary(summary: DirtyDirSummary): void {
      upsertDirtyDirStmt.run(
        workdirKey,
        summary.path,
        summary.isDirty ? 1 : 0,
        summary.dirtyEntryCount,
        summary.dirtyDescendantCount,
        JSON.stringify(summary.affectedNames),
        summary.currentTreeHash,
        summary.hashState,
      );
    },

    deleteDirtyDirSummary(path: string): void {
      deleteDirtyDirStmt.run(workdirKey, path);
    },

    reset(baseTree: SHA1): void {
      resetTx(baseTree);
    },
  };
}

function ensureSchema(db: Database): void {
  const currentVersion = readSchemaVersion(db);
  if (currentVersion !== 0 && currentVersion !== WORKDIR_SQLITE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported virtual workdir SQLite schema version: expected ${WORKDIR_SQLITE_SCHEMA_VERSION}, got ${currentVersion}`,
    );
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS workdirs (
      workdir_key TEXT PRIMARY KEY,
      base_tree TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS workdir_nodes (
      workdir_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      origin_kind TEXT NOT NULL,
      origin_hash TEXT,
      origin_mode TEXT,
      state_kind TEXT NOT NULL,
      state_mode TEXT,
      content BLOB,
      target BLOB,
      directory_overlay TEXT,
      PRIMARY KEY (workdir_key, node_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS workdir_changes (
      workdir_key TEXT NOT NULL,
      path TEXT NOT NULL,
      previous_kind TEXT,
      previous_mode TEXT,
      previous_hash TEXT,
      current_kind TEXT,
      current_mode TEXT,
      current_hash TEXT,
      source_kind TEXT,
      source_path TEXT,
      PRIMARY KEY (workdir_key, path)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS workdir_dirty_dirs (
      workdir_key TEXT NOT NULL,
      path TEXT NOT NULL,
      is_dirty INTEGER NOT NULL,
      dirty_entry_count INTEGER NOT NULL,
      dirty_descendant_count INTEGER NOT NULL,
      affected_names TEXT NOT NULL,
      current_tree_hash TEXT,
      hash_state TEXT NOT NULL,
      PRIMARY KEY (workdir_key, path)
    )
  `);
  writeSchemaVersion(db, WORKDIR_SQLITE_SCHEMA_VERSION);
}

function hasWorkdir(db: Database, workdirKey: string): boolean {
  const stmt = db.query<{ "1": number } | null, [string]>(
    "SELECT 1 FROM workdirs WHERE workdir_key = ?",
  );
  return stmt.get(workdirKey) !== null;
}

function deleteWorkdirRows(db: Database, workdirKey: string): void {
  const tx = db.transaction(() => {
    db.query<void, [string]>("DELETE FROM workdir_dirty_dirs WHERE workdir_key = ?").run(
      workdirKey,
    );
    db.query<void, [string]>("DELETE FROM workdir_changes WHERE workdir_key = ?").run(workdirKey);
    db.query<void, [string]>("DELETE FROM workdir_nodes WHERE workdir_key = ?").run(workdirKey);
    db.query<void, [string]>("DELETE FROM workdirs WHERE workdir_key = ?").run(workdirKey);
  });
  tx();
}

function readSchemaVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

function writeSchemaVersion(db: Database, version: number): void {
  db.run(`PRAGMA user_version = ${version}`);
}

function validateWorkdirIntegrity(db: Database, workdirKey: string): void {
  const workdirStmt = db.query<Pick<WorkdirRow, "base_tree"> | null, [string]>(
    "SELECT base_tree FROM workdirs WHERE workdir_key = ?",
  );
  const workdirRow = workdirStmt.get(workdirKey);
  if (workdirRow === null) {
    throw new Error(`Virtual workdir not found: ${workdirKey}`);
  }
  readBaseTreeValue(workdirRow.base_tree);

  const rootStmt = db.query<NodeRow | null, [string, string]>(
    `SELECT node_id, origin_kind, origin_hash, origin_mode, state_kind, state_mode, content, target, directory_overlay
     FROM workdir_nodes
     WHERE workdir_key = ? AND node_id = ?`,
  );
  const rootRow = rootStmt.get(workdirKey, "root");
  if (rootRow === null) {
    throw new Error(`Virtual workdir is corrupted: missing root node for ${workdirKey}`);
  }
  const rootNode = readNode(rootRow);
  if (rootNode.state.kind !== "directory") {
    throw new Error(`Virtual workdir is corrupted: root node is not a directory for ${workdirKey}`);
  }

  const allNodesStmt = db.query<NodeRow, [string]>(
    `SELECT node_id, origin_kind, origin_hash, origin_mode, state_kind, state_mode, content, target, directory_overlay
     FROM workdir_nodes
     WHERE workdir_key = ?`,
  );
  for (const row of allNodesStmt.all(workdirKey)) {
    readNode(row);
  }
}

function writeNode(
  stmt: ReturnType<Database["query"]>,
  workdirKey: string,
  node: WorkdirNode,
): void {
  if (node.state.kind === "directory") {
    stmt.run(
      workdirKey,
      node.id,
      node.origin.kind,
      node.origin.kind === "none" ? null : node.origin.hash,
      node.origin.kind === "repo-blob" ? node.origin.mode : null,
      "directory",
      null,
      null,
      null,
      JSON.stringify({
        addedEntries: Array.from(node.state.overlay.addedEntries.entries()),
        deletedNames: Array.from(node.state.overlay.deletedNames.values()),
      }),
    );
    return;
  }

  if (node.state.kind === "file") {
    stmt.run(
      workdirKey,
      node.id,
      node.origin.kind,
      node.origin.kind === "none" ? null : node.origin.hash,
      node.origin.kind === "repo-blob" ? node.origin.mode : null,
      "file",
      node.state.mode,
      node.state.content ?? null,
      null,
      null,
    );
    return;
  }

  stmt.run(
    workdirKey,
    node.id,
    node.origin.kind,
    node.origin.kind === "none" ? null : node.origin.hash,
    node.origin.kind === "repo-blob" ? node.origin.mode : null,
    "symlink",
    "120000",
    null,
    node.state.target ?? null,
    null,
  );
}

function readNode(row: NodeRow): WorkdirNode {
  const origin = readNodeOrigin(row);

  if (row.state_kind === "directory") {
    if (row.state_mode !== null || row.content !== null || row.target !== null) {
      throw new Error("Invalid SQLite workdir directory node payload columns");
    }
    const overlay = readDirectoryOverlay(row.directory_overlay);
    return {
      id: row.node_id as NodeId,
      origin,
      state: { kind: "directory", overlay },
    };
  }

  if (row.state_kind === "file") {
    if (row.state_mode !== "100644" && row.state_mode !== "100755") {
      throw new Error(`Invalid SQLite workdir node state mode: ${row.state_mode ?? "null"}`);
    }
    if (row.target !== null || row.directory_overlay !== null) {
      throw new Error("Invalid SQLite workdir file node payload columns");
    }
    return {
      id: row.node_id as NodeId,
      origin,
      state: {
        kind: "file",
        mode: row.state_mode,
        content: readBlobColumn(row.content, "content"),
      },
    };
  }

  if (row.state_kind !== "symlink") {
    throw new Error(`Invalid SQLite workdir node state kind: ${row.state_kind}`);
  }
  if (row.state_mode !== "120000") {
    throw new Error(`Invalid SQLite workdir node state mode: ${row.state_mode ?? "null"}`);
  }
  if (row.content !== null || row.directory_overlay !== null) {
    throw new Error("Invalid SQLite workdir symlink node payload columns");
  }

  return {
    id: row.node_id as NodeId,
    origin,
    state: {
      kind: "symlink",
      mode: "120000",
      target: readBlobColumn(row.target, "target"),
    },
  };
}

function readNodeOrigin(row: NodeRow): WorkdirNode["origin"] {
  if (row.origin_kind === "none") {
    return { kind: "none" };
  }

  if (row.origin_kind === "repo-tree") {
    if (row.origin_hash === null) {
      throw new Error("Invalid SQLite workdir node: repo-tree origin is missing hash");
    }
    return { kind: "repo-tree", hash: row.origin_hash as SHA1 };
  }

  if (row.origin_kind === "repo-blob") {
    if (row.origin_hash === null) {
      throw new Error("Invalid SQLite workdir node: repo-blob origin is missing hash");
    }
    if (
      row.origin_mode !== "100644" &&
      row.origin_mode !== "100755" &&
      row.origin_mode !== "120000"
    ) {
      throw new Error(`Invalid SQLite workdir node origin mode: ${row.origin_mode ?? "null"}`);
    }
    return {
      kind: "repo-blob",
      mode: row.origin_mode,
      hash: row.origin_hash as SHA1,
    };
  }

  throw new Error(`Invalid SQLite workdir node origin kind: ${row.origin_kind}`);
}

function readChangeRecord(row: ChangeRow): NormalizedChangeRecord {
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
    source:
      row.source_kind === null || row.source_path === null
        ? null
        : {
            kind: readDiffSourceKind(row.source_kind),
            path: row.source_path,
          },
  };
}

function readDiffObjectKind(raw: string): "blob" | "tree" | "symlink" {
  if (raw === "blob" || raw === "tree" || raw === "symlink") {
    return raw;
  }
  throw new Error(`Invalid SQLite workdir diff object kind: ${raw}`);
}

function readDiffObjectMode(raw: string): "100644" | "100755" | "040000" | "120000" {
  if (raw === "100644" || raw === "100755" || raw === "040000" || raw === "120000") {
    return raw;
  }
  throw new Error(`Invalid SQLite workdir diff object mode: ${raw}`);
}

/** 解析 diff 来源种类；旧版 `rename` 读入时规范为 `move`。 */
function readDiffSourceKind(raw: string): "move" | "copy" {
  if (raw === "move" || raw === "copy") {
    return raw;
  }
  if (raw === "rename") {
    return "move";
  }
  throw new Error(`Invalid SQLite workdir diff source kind: ${raw}`);
}

function readDirtyDirSummary(row: DirtyDirRow): DirtyDirSummary {
  const affectedNames = readDirtyDirAffectedNames(row.affected_names);
  return {
    path: row.path,
    isDirty: row.is_dirty !== 0,
    dirtyEntryCount: readDirtyDirCount(row.dirty_entry_count, "dirty_entry_count"),
    dirtyDescendantCount: readDirtyDirCount(row.dirty_descendant_count, "dirty_descendant_count"),
    affectedNames,
    currentTreeHash: row.current_tree_hash === null ? null : sha1(row.current_tree_hash),
    hashState: readDirtyDirHashState(row.hash_state),
  };
}

function readDirtyDirCount(raw: number, field: string): number {
  if (!Number.isInteger(raw) || raw < 0) {
    throw new Error(`Invalid SQLite workdir dirty dir ${field}: ${raw}`);
  }
  return raw;
}

function readDirtyDirAffectedNames(raw: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid SQLite workdir dirty dir affected_names JSON");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Invalid SQLite workdir dirty dir affected_names payload");
  }
  const names = parsed as string[];
  return [...names].sort((left, right) => left.localeCompare(right));
}

function readDirtyDirHashState(raw: string): DirtyDirHashState {
  if (raw === "stale" || raw === "materialized") {
    return raw;
  }
  throw new Error(`Invalid SQLite workdir dirty dir hash state: ${raw}`);
}

function readDirectoryOverlay(raw: unknown): DirectoryOverlay {
  if (raw === null) {
    return { addedEntries: new Map(), deletedNames: new Set() };
  }
  if (typeof raw !== "string") {
    throw new Error("Invalid SQLite workdir directory overlay column type");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid SQLite workdir directory overlay JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isDirectoryOverlayPayload(parsed)) {
    throw new Error("Invalid SQLite workdir directory overlay payload");
  }

  const addedEntries: Array<[string, NodeId]> = parsed.addedEntries.map(([name, nodeId]) => [
    name,
    nodeId as NodeId,
  ]);
  return {
    addedEntries: new Map(addedEntries),
    deletedNames: new Set(parsed.deletedNames),
  };
}

function readBlobColumn(raw: unknown, column: "content" | "target"): Buffer | undefined {
  if (raw === null) {
    return undefined;
  }
  if (!(raw instanceof Uint8Array)) {
    throw new Error(`Invalid SQLite workdir ${column} column type`);
  }
  return Buffer.from(raw);
}

function readBaseTreeValue(raw: unknown): SHA1 {
  if (typeof raw !== "string") {
    throw new Error("Invalid SQLite workdir base_tree");
  }
  try {
    return sha1(raw);
  } catch {
    throw new Error("Invalid SQLite workdir base_tree");
  }
}

function isDirectoryOverlayPayload(
  value: unknown,
): value is { addedEntries: Array<[string, string]>; deletedNames: string[] } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const maybe = value as {
    addedEntries?: unknown;
    deletedNames?: unknown;
  };
  if (!Array.isArray(maybe.addedEntries) || !Array.isArray(maybe.deletedNames)) {
    return false;
  }

  const hasValidAddedEntries = maybe.addedEntries.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "string" &&
      typeof entry[1] === "string",
  );
  const hasValidDeletedNames = maybe.deletedNames.every((name) => typeof name === "string");
  return hasValidAddedEntries && hasValidDeletedNames;
}
