/**
 * Virtual Workdir SQLite backend
 */

import { Database } from "bun:sqlite";

import { sha1 } from "../core/types.ts";
import { createRootDirectoryNode, type SessionNode } from "./nodes.ts";
import { createVirtualWorkdirSessionId } from "./session-id.ts";
import { openVirtualWorkdirSession } from "./session.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectDatabase } from "../core/types/odb.ts";
import type { NormalizedChangeRecord } from "./change-index.ts";
import type {
  CreateVirtualWorkdirSessionOptions,
  VirtualWorkdirBackend,
  VirtualWorkdirSession,
  VirtualWorkdirSessionId,
} from "./core.ts";
import type { DirtyDirHashState, DirtyDirSummary } from "./dirty-dir.ts";
import type { NodeId } from "./ids.ts";
import type { DirectoryOverlay } from "./overlay.ts";
import type { VirtualWorkdirStateStore } from "./state-store.ts";

/** 创建 SQLite Virtual Workdir backend 的可选参数 */
export interface CreateSqliteVirtualWorkdirBackendOptions {
  /** 开启 WAL 模式，默认 true */
  readonly walMode?: boolean;
}

/**
 * SQLite Virtual Workdir backend（含资源释放能力）
 */
export interface SqliteVirtualWorkdirBackend extends VirtualWorkdirBackend {
  /** 释放 SQLite 数据库连接 */
  [Symbol.dispose](): void;
}

const WORKDIR_SQLITE_SCHEMA_VERSION = 5;

interface SessionRow {
  session_id: string;
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
 * 创建基于 SQLite 的 Virtual Workdir backend
 *
 * @example
 * ```ts
 * using backend = createSqliteVirtualWorkdirBackend(":memory:");
 * const sessionId = backend.createSession({ baseTree: tree });
 * const session = backend.openSession(repo.objects, sessionId);
 * expect(session.baseTree).toBe(tree);
 * ```
 */
export function createSqliteVirtualWorkdirBackend(
  dbPath: string,
  options: CreateSqliteVirtualWorkdirBackendOptions = {},
): SqliteVirtualWorkdirBackend {
  const db = new Database(dbPath);
  let disposed = false;

  if (options.walMode !== false) {
    db.run("PRAGMA journal_mode = WAL");
  }

  ensureSchema(db);

  return {
    kind: "sqlite",

    createSession(options: CreateVirtualWorkdirSessionOptions): VirtualWorkdirSessionId {
      assertBackendAvailable(disposed);
      const sessionId = createVirtualWorkdirSessionId();
      const store = createSqliteVirtualWorkdirStateStore(db, sessionId);
      store.reset(options.baseTree);
      return sessionId;
    },

    openSession(source: ObjectDatabase, sessionId: VirtualWorkdirSessionId): VirtualWorkdirSession {
      assertBackendAvailable(disposed);
      if (!hasSession(db, sessionId)) {
        throw new Error(`Virtual workdir session not found: ${sessionId}`);
      }
      validateSessionIntegrity(db, sessionId);
      const store = createSqliteVirtualWorkdirStateStore(db, sessionId);
      return openVirtualWorkdirSession(source, store);
    },

    deleteSession(sessionId: VirtualWorkdirSessionId): void {
      assertBackendAvailable(disposed);
      if (!hasSession(db, sessionId)) {
        throw new Error(`Virtual workdir session not found: ${sessionId}`);
      }
      deleteSessionRows(db, sessionId);
    },

    listSessions(): VirtualWorkdirSessionId[] {
      assertBackendAvailable(disposed);
      const stmt = db.query<Pick<SessionRow, "session_id">, []>(
        "SELECT session_id FROM workdir_sessions ORDER BY session_id",
      );
      return stmt
        .all()
        .map((row) => row.session_id as VirtualWorkdirSessionId)
        .filter((sessionId) => {
          try {
            validateSessionIntegrity(db, sessionId);
            return true;
          } catch {
            return false;
          }
        });
    },

    [Symbol.dispose](): void {
      if (disposed) {
        return;
      }
      disposed = true;
      db.close();
    },
  };
}

function assertBackendAvailable(disposed: boolean): void {
  if (disposed) {
    throw new Error("SQLite virtual workdir backend is disposed");
  }
}

/**
 * 创建单个 session 的 SQLite 状态存储
 *
 * @example
 * ```ts
 * const store = createSqliteVirtualWorkdirStateStore(db, sessionId);
 * expect(store.kind).toBe("sqlite");
 * ```
 */
export function createSqliteVirtualWorkdirStateStore(
  db: Database,
  sessionId: VirtualWorkdirSessionId,
): VirtualWorkdirStateStore {
  const transactImpl = db.transaction((fn: () => unknown) => fn());
  const readBaseTreeStmt = db.query<Pick<SessionRow, "base_tree"> | null, [string]>(
    "SELECT base_tree FROM workdir_sessions WHERE session_id = ?",
  );
  const upsertSessionStmt = db.query<void, [string, string]>(
    "INSERT INTO workdir_sessions (session_id, base_tree) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET base_tree = excluded.base_tree",
  );
  const getNodeStmt = db.query<NodeRow | null, [string, string]>(
    `SELECT node_id, origin_kind, origin_hash, origin_mode, state_kind, state_mode, content, target, directory_overlay
     FROM workdir_nodes
     WHERE session_id = ? AND node_id = ?`,
  );
  const setNodeStmt = db.query<
    void,
    [
      string,
      string,
      string,
      string | null,
      string | null,
      string,
      string | null,
      Uint8Array | null,
      Uint8Array | null,
      string | null,
    ]
  >(
    `INSERT INTO workdir_nodes (
        session_id, node_id, origin_kind, origin_hash, origin_mode,
        state_kind, state_mode, content, target, directory_overlay
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, node_id) DO UPDATE SET
        origin_kind = excluded.origin_kind,
        origin_hash = excluded.origin_hash,
        origin_mode = excluded.origin_mode,
        state_kind = excluded.state_kind,
        state_mode = excluded.state_mode,
        content = excluded.content,
        target = excluded.target,
        directory_overlay = excluded.directory_overlay`,
  );
  const deleteNodeStmt = db.query<void, [string, string]>(
    "DELETE FROM workdir_nodes WHERE session_id = ? AND node_id = ?",
  );
  const clearNodesStmt = db.query<void, [string]>("DELETE FROM workdir_nodes WHERE session_id = ?");
  const listChangesStmt = db.query<ChangeRow, [string]>(
    `SELECT path, previous_kind, previous_mode, previous_hash, current_kind, current_mode, current_hash, source_kind, source_path
     FROM workdir_changes
     WHERE session_id = ?
     ORDER BY path`,
  );
  const getChangeStmt = db.query<ChangeRow | null, [string, string]>(
    `SELECT path, previous_kind, previous_mode, previous_hash, current_kind, current_mode, current_hash, source_kind, source_path
     FROM workdir_changes
     WHERE session_id = ? AND path = ?`,
  );
  const upsertChangeStmt = db.query<
    void,
    [
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ]
  >(
    `INSERT INTO workdir_changes (
      session_id, path, previous_kind, previous_mode, previous_hash,
      current_kind, current_mode, current_hash, source_kind, source_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, path) DO UPDATE SET
      previous_kind = excluded.previous_kind,
      previous_mode = excluded.previous_mode,
      previous_hash = excluded.previous_hash,
      current_kind = excluded.current_kind,
      current_mode = excluded.current_mode,
      current_hash = excluded.current_hash,
      source_kind = excluded.source_kind,
      source_path = excluded.source_path`,
  );
  const deleteChangeStmt = db.query<void, [string, string]>(
    "DELETE FROM workdir_changes WHERE session_id = ? AND path = ?",
  );
  const clearChangesStmt = db.query<void, [string]>(
    "DELETE FROM workdir_changes WHERE session_id = ?",
  );
  const listDirtyDirsStmt = db.query<DirtyDirRow, [string]>(
    `SELECT path, is_dirty, dirty_entry_count, dirty_descendant_count, affected_names, current_tree_hash, hash_state
     FROM workdir_dirty_dirs
     WHERE session_id = ?
     ORDER BY path`,
  );
  const getDirtyDirStmt = db.query<DirtyDirRow | null, [string, string]>(
    `SELECT path, is_dirty, dirty_entry_count, dirty_descendant_count, affected_names, current_tree_hash, hash_state
     FROM workdir_dirty_dirs
     WHERE session_id = ? AND path = ?`,
  );
  const upsertDirtyDirStmt = db.query<
    void,
    [string, string, number, number, number, string, string | null, DirtyDirHashState]
  >(
    `INSERT INTO workdir_dirty_dirs (
      session_id, path, is_dirty, dirty_entry_count, dirty_descendant_count,
      affected_names, current_tree_hash, hash_state
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, path) DO UPDATE SET
       is_dirty = excluded.is_dirty,
       dirty_entry_count = excluded.dirty_entry_count,
       dirty_descendant_count = excluded.dirty_descendant_count,
       affected_names = excluded.affected_names,
       current_tree_hash = excluded.current_tree_hash,
       hash_state = excluded.hash_state`,
  );
  const deleteDirtyDirStmt = db.query<void, [string, string]>(
    "DELETE FROM workdir_dirty_dirs WHERE session_id = ? AND path = ?",
  );
  const clearDirtyDirsStmt = db.query<void, [string]>(
    "DELETE FROM workdir_dirty_dirs WHERE session_id = ?",
  );

  const resetTx = db.transaction((baseTree: SHA1) => {
    upsertSessionStmt.run(sessionId, baseTree);
    clearNodesStmt.run(sessionId);
    clearChangesStmt.run(sessionId);
    clearDirtyDirsStmt.run(sessionId);
    writeNode(setNodeStmt, sessionId, createRootDirectoryNode(baseTree));
  });

  return {
    kind: "sqlite",

    transact<T>(fn: () => T): T {
      return transactImpl(fn) as T;
    },

    readBaseTree(): SHA1 {
      const row = readBaseTreeStmt.get(sessionId);
      if (row === null) {
        throw new Error(`Virtual workdir session not found: ${sessionId}`);
      }
      return readBaseTreeValue(row.base_tree);
    },

    writeBaseTree(baseTree: SHA1): void {
      upsertSessionStmt.run(sessionId, baseTree);
    },

    getNode(id: NodeId): SessionNode | null {
      const row = getNodeStmt.get(sessionId, id);
      if (row === null) {
        return null;
      }
      return readNode(row);
    },

    setNode(node: SessionNode): void {
      writeNode(setNodeStmt, sessionId, node);
    },

    deleteNode(id: NodeId): void {
      deleteNodeStmt.run(sessionId, id);
    },

    listChangeRecords(): readonly NormalizedChangeRecord[] {
      return listChangesStmt.all(sessionId).map(readChangeRecord);
    },

    getChangeRecord(path: string): NormalizedChangeRecord | null {
      const row = getChangeStmt.get(sessionId, path);
      return row === null ? null : readChangeRecord(row);
    },

    setChangeRecord(record: NormalizedChangeRecord): void {
      upsertChangeStmt.run(
        sessionId,
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
      deleteChangeStmt.run(sessionId, path);
    },

    listDirtyDirSummaries(): readonly DirtyDirSummary[] {
      return listDirtyDirsStmt.all(sessionId).map(readDirtyDirSummary);
    },

    getDirtyDirSummary(path: string): DirtyDirSummary | null {
      const row = getDirtyDirStmt.get(sessionId, path);
      return row === null ? null : readDirtyDirSummary(row);
    },

    setDirtyDirSummary(summary: DirtyDirSummary): void {
      upsertDirtyDirStmt.run(
        sessionId,
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
      deleteDirtyDirStmt.run(sessionId, path);
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
    CREATE TABLE IF NOT EXISTS workdir_sessions (
      session_id TEXT PRIMARY KEY,
      base_tree TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS workdir_nodes (
      session_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      origin_kind TEXT NOT NULL,
      origin_hash TEXT,
      origin_mode TEXT,
      state_kind TEXT NOT NULL,
      state_mode TEXT,
      content BLOB,
      target BLOB,
      directory_overlay TEXT,
      PRIMARY KEY (session_id, node_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS workdir_changes (
      session_id TEXT NOT NULL,
      path TEXT NOT NULL,
      previous_kind TEXT,
      previous_mode TEXT,
      previous_hash TEXT,
      current_kind TEXT,
      current_mode TEXT,
      current_hash TEXT,
      source_kind TEXT,
      source_path TEXT,
      PRIMARY KEY (session_id, path)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS workdir_dirty_dirs (
      session_id TEXT NOT NULL,
      path TEXT NOT NULL,
      is_dirty INTEGER NOT NULL,
      dirty_entry_count INTEGER NOT NULL,
      dirty_descendant_count INTEGER NOT NULL,
      affected_names TEXT NOT NULL,
      current_tree_hash TEXT,
      hash_state TEXT NOT NULL,
      PRIMARY KEY (session_id, path)
    )
  `);
  writeSchemaVersion(db, WORKDIR_SQLITE_SCHEMA_VERSION);
}

function hasSession(db: Database, sessionId: VirtualWorkdirSessionId): boolean {
  const stmt = db.query<{ "1": number } | null, [string]>(
    "SELECT 1 FROM workdir_sessions WHERE session_id = ?",
  );
  return stmt.get(sessionId) !== null;
}

function deleteSessionRows(db: Database, sessionId: VirtualWorkdirSessionId): void {
  const tx = db.transaction(() => {
    db.query<void, [string]>("DELETE FROM workdir_dirty_dirs WHERE session_id = ?").run(sessionId);
    db.query<void, [string]>("DELETE FROM workdir_changes WHERE session_id = ?").run(sessionId);
    db.query<void, [string]>("DELETE FROM workdir_nodes WHERE session_id = ?").run(sessionId);
    db.query<void, [string]>("DELETE FROM workdir_sessions WHERE session_id = ?").run(sessionId);
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

function validateSessionIntegrity(db: Database, sessionId: VirtualWorkdirSessionId): void {
  const sessionStmt = db.query<Pick<SessionRow, "base_tree"> | null, [string]>(
    "SELECT base_tree FROM workdir_sessions WHERE session_id = ?",
  );
  const sessionRow = sessionStmt.get(sessionId);
  if (sessionRow === null) {
    throw new Error(`Virtual workdir session not found: ${sessionId}`);
  }
  readBaseTreeValue(sessionRow.base_tree);

  const rootStmt = db.query<NodeRow | null, [string, string]>(
    `SELECT node_id, origin_kind, origin_hash, origin_mode, state_kind, state_mode, content, target, directory_overlay
     FROM workdir_nodes
     WHERE session_id = ? AND node_id = ?`,
  );
  const rootRow = rootStmt.get(sessionId, "root");
  if (rootRow === null) {
    throw new Error(`Virtual workdir session is corrupted: missing root node for ${sessionId}`);
  }
  const rootNode = readNode(rootRow);
  if (rootNode.state.kind !== "directory") {
    throw new Error(
      `Virtual workdir session is corrupted: root node is not a directory for ${sessionId}`,
    );
  }

  const allNodesStmt = db.query<NodeRow, [string]>(
    `SELECT node_id, origin_kind, origin_hash, origin_mode, state_kind, state_mode, content, target, directory_overlay
     FROM workdir_nodes
     WHERE session_id = ?`,
  );
  for (const row of allNodesStmt.all(sessionId)) {
    readNode(row);
  }
}

function writeNode(
  stmt: ReturnType<Database["query"]>,
  sessionId: VirtualWorkdirSessionId,
  node: SessionNode,
): void {
  if (node.state.kind === "directory") {
    stmt.run(
      sessionId,
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
      sessionId,
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
    sessionId,
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

function readNode(row: NodeRow): SessionNode {
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

function readNodeOrigin(row: NodeRow): SessionNode["origin"] {
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

function readDiffObjectKind(raw: string): "blob" | "symlink" {
  if (raw === "blob" || raw === "symlink") {
    return raw;
  }
  throw new Error(`Invalid SQLite workdir diff object kind: ${raw}`);
}

function readDiffObjectMode(raw: string): "100644" | "100755" | "120000" {
  if (raw === "100644" || raw === "100755" || raw === "120000") {
    return raw;
  }
  throw new Error(`Invalid SQLite workdir diff object mode: ${raw}`);
}

function readDiffSourceKind(raw: string): "rename" | "copy" {
  if (raw === "rename" || raw === "copy") {
    return raw;
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
    throw new Error("Invalid SQLite workdir session base_tree");
  }
  try {
    return sha1(raw);
  } catch {
    throw new Error("Invalid SQLite workdir session base_tree");
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
