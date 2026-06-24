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
import type { InternalChangeRecord } from "./change-log.ts";
import type {
  CreateVirtualWorkdirSessionOptions,
  VirtualWorkdirBackend,
  VirtualWorkdirSession,
  VirtualWorkdirSessionId,
} from "./core.ts";
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

const WORKDIR_SQLITE_SCHEMA_VERSION = 1;
const WORKDIR_CHANGES_SESSION_ORDER_INDEX = "workdir_changes_session_id_id_idx";

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
  op: string;
  path: string | null;
  old_path: string | null;
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
  const listChangesStmt = db.query<ChangeRow, [string]>(
    "SELECT op, path, old_path FROM workdir_changes WHERE session_id = ? ORDER BY id",
  );
  const insertChangeStmt = db.query<void, [string, string, string | null, string | null]>(
    "INSERT INTO workdir_changes (session_id, op, path, old_path) VALUES (?, ?, ?, ?)",
  );
  const clearNodesStmt = db.query<void, [string]>("DELETE FROM workdir_nodes WHERE session_id = ?");
  const clearChangesStmt = db.query<void, [string]>(
    "DELETE FROM workdir_changes WHERE session_id = ?",
  );

  const resetTx = db.transaction((baseTree: SHA1) => {
    upsertSessionStmt.run(sessionId, baseTree);
    clearNodesStmt.run(sessionId);
    clearChangesStmt.run(sessionId);
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

    appendChange(record: InternalChangeRecord): void {
      insertChangeStmt.run(sessionId, record.op, getRecordPath(record), getRecordOldPath(record));
    },

    listChangeRecords(): readonly InternalChangeRecord[] {
      return listChangesStmt.all(sessionId).map(readChangeRecord);
    },

    clearChanges(): void {
      clearChangesStmt.run(sessionId);
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      op TEXT NOT NULL,
      path TEXT,
      old_path TEXT
    )
  `);
  // `workdir_sessions` 与 `workdir_nodes` 的查询模式已被主键或主键前缀覆盖；
  // `workdir_changes` 仍需要按 session 顺序读取与按 session 清理，
  // 因此补一个最小组合索引，避免退化为全表扫描。
  db.run(`
    CREATE INDEX IF NOT EXISTS ${WORKDIR_CHANGES_SESSION_ORDER_INDEX}
    ON workdir_changes (session_id, id)
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

function getRecordPath(record: InternalChangeRecord): string | null {
  switch (record.op) {
    case "add":
    case "modify":
    case "delete":
    case "revert":
      return record.path;
    case "rename":
    case "copy":
      return record.to;
    default: {
      const _exhaustive: never = record;
      return _exhaustive;
    }
  }
}

function getRecordOldPath(record: InternalChangeRecord): string | null {
  if (record.op === "rename" || record.op === "copy") {
    return record.from;
  }
  return null;
}

function readChangeRecord(row: ChangeRow): InternalChangeRecord {
  switch (row.op) {
    case "add":
    case "modify":
    case "delete":
    case "revert":
      return { op: row.op, path: row.path! };
    case "rename":
    case "copy":
      return { op: row.op, from: row.old_path!, to: row.path! };
    default:
      throw new Error(`Unknown workdir change op: ${row.op}`);
  }
}
