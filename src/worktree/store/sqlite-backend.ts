/**
 * Virtual Worktree SQLite backend
 */

import { acquireConnection, type SqliteConnectionHandle } from "../../backend/sqlite-pool.ts";
import { sha1 } from "../../core/types.ts";
import { openVirtualWorktree } from "../engine/worktree.ts";
import { createRootDirectoryNode, type WorktreeNode } from "../model/nodes.ts";
import { parseChangeRecordFromSqlite } from "./persist/change-codec.ts";
import { parseNodeOriginFromSqliteColumns } from "./persist/origin-codec.ts";
import {
  parseDirectoryOverlay,
  serializeDirectoryOverlayPayload,
} from "./persist/overlay-codec.ts";

import type { SHA1 } from "../../core/types.ts";
import type { ObjectDatabase } from "../../core/types/odb.ts";
import type { CreateVirtualWorktreeOptions, VirtualWorktree } from "../core.ts";
import type { NormalizedChangeRecord } from "../engine/change-index.ts";
import type { NodeId } from "../model/ids.ts";
import type { SqliteChangeRow } from "./persist/change-codec.ts";
import type { VirtualWorktreeStateStore } from "./state-store.ts";
import type { Database } from "native-sqlite";

/** SQLite 连接层的可选参数 */
export interface SqliteVirtualWorktreeConnectionOptions {
  /** 开启 WAL 模式，默认 true */
  readonly walMode?: boolean;
}

/** 打开 SQLite VirtualWorktree 的可选参数 */
export interface OpenSqliteVirtualWorktreeOptions
  extends CreateVirtualWorktreeOptions, SqliteVirtualWorktreeConnectionOptions {
  /** 不存在时按 baseTree 初始化 */
  readonly create?: boolean;
}

/**
 * 基于 SQLite 的 VirtualWorktree
 *
 * 返回值附带 `[Symbol.dispose]()`，用于释放内部数据库连接。
 */
export type SqliteVirtualWorktree = VirtualWorktree & { [Symbol.dispose](): void };

const WORKTREE_SQLITE_SCHEMA_VERSION = 8;

interface WorktreeRow {
  worktree_key: string;
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

/**
 * 打开基于 SQLite 的持久化 VirtualWorktree
 *
 * @example
 * ```ts
 * using worktree = openSqliteVirtualWorktree(repo.objects, ":memory:", "demo", {
 *   baseTree: tree,
 *   create: true,
 * });
 * expect(worktree.baseTree).toBe(tree);
 * ```
 */
export function openSqliteVirtualWorktree(
  source: ObjectDatabase,
  dbPath: string,
  worktreeKey: string,
  options: OpenSqliteVirtualWorktreeOptions,
): SqliteVirtualWorktree {
  const conn = acquireConnection(dbPath, options.walMode !== false);
  try {
    ensureSchema(conn.db);
    const store = createSqliteVirtualWorktreeStateStore(conn, worktreeKey);
    if (!hasWorktree(conn.db, worktreeKey)) {
      if (options.create !== true) {
        throw new Error(`Virtual worktree not found: ${worktreeKey}`);
      }
      store.reset(options.baseTree);
    }
    validateWorktreeIntegrity(conn.db, worktreeKey);

    let released = false;
    const worktree = openVirtualWorktree(source, store);
    return Object.assign(worktree, {
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
 * 删除指定 key 上的 SQLite VirtualWorktree
 *
 * @example
 * ```ts
 * deleteSqliteVirtualWorktree("/tmp/worktree.sqlite", "demo");
 * ```
 */
export function deleteSqliteVirtualWorktree(
  dbPath: string,
  worktreeKey: string,
  options: SqliteVirtualWorktreeConnectionOptions = {},
): void {
  const conn = acquireConnection(dbPath, options.walMode !== false);
  try {
    ensureSchema(conn.db);
    if (!hasWorktree(conn.db, worktreeKey)) {
      throw new Error(`Virtual worktree not found: ${worktreeKey}`);
    }
    deleteWorktreeRows(conn.db, worktreeKey);
  } finally {
    conn.release();
  }
}

/**
 * 创建单个 SQLite VirtualWorktree 的状态存储
 *
 * @example
 * ```ts
 * using conn = acquireConnection("/tmp/worktree.sqlite");
 * const store = createSqliteVirtualWorktreeStateStore(conn, "demo");
 * expect(store.kind).toBe("sqlite");
 * ```
 */
export function createSqliteVirtualWorktreeStateStore(
  conn: SqliteConnectionHandle,
  worktreeKey: string,
): VirtualWorktreeStateStore {
  const transactImpl = conn.db.transaction((fn: () => unknown) => fn());
  const readBaseTreeStmt = conn.prepare<Pick<WorktreeRow, "base_tree"> | null>(
    "SELECT base_tree FROM worktrees WHERE worktree_key = ?",
  );
  const upsertWorktreeStmt = conn.prepare<void>(
    "INSERT INTO worktrees (worktree_key, base_tree) VALUES (?, ?) ON CONFLICT(worktree_key) DO UPDATE SET base_tree = excluded.base_tree",
  );
  const getNodeStmt = conn.prepare<NodeRow | null>(
    `SELECT node_id, origin_kind, origin_hash, origin_mode, state_kind, state_mode, content, target, directory_overlay
     FROM worktree_nodes
     WHERE worktree_key = ? AND node_id = ?`,
  );
  const setNodeStmt = conn.prepare<void>(
    `INSERT INTO worktree_nodes (
        worktree_key, node_id, origin_kind, origin_hash, origin_mode,
        state_kind, state_mode, content, target, directory_overlay
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worktree_key, node_id) DO UPDATE SET
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
    "DELETE FROM worktree_nodes WHERE worktree_key = ? AND node_id = ?",
  );
  const clearNodesStmt = conn.prepare<void>("DELETE FROM worktree_nodes WHERE worktree_key = ?");
  const listChangesStmt = conn.prepare<SqliteChangeRow>(
    `SELECT path, previous_kind, previous_mode, previous_hash, current_kind, current_mode, current_hash
     FROM worktree_changes
     WHERE worktree_key = ?
     ORDER BY path`,
  );
  const getChangeStmt = conn.prepare<SqliteChangeRow | null>(
    `SELECT path, previous_kind, previous_mode, previous_hash, current_kind, current_mode, current_hash
     FROM worktree_changes
     WHERE worktree_key = ? AND path = ?`,
  );
  const upsertChangeStmt = conn.prepare<void>(
    `INSERT INTO worktree_changes (
      worktree_key, path, previous_kind, previous_mode, previous_hash,
      current_kind, current_mode, current_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(worktree_key, path) DO UPDATE SET
      previous_kind = excluded.previous_kind,
      previous_mode = excluded.previous_mode,
      previous_hash = excluded.previous_hash,
      current_kind = excluded.current_kind,
      current_mode = excluded.current_mode,
      current_hash = excluded.current_hash`,
  );
  const deleteChangeStmt = conn.prepare<void>(
    "DELETE FROM worktree_changes WHERE worktree_key = ? AND path = ?",
  );
  const clearChangesStmt = conn.prepare<void>(
    "DELETE FROM worktree_changes WHERE worktree_key = ?",
  );

  const resetTx = conn.db.transaction((baseTree: SHA1) => {
    upsertWorktreeStmt.run(worktreeKey, baseTree);
    clearNodesStmt.run(worktreeKey);
    clearChangesStmt.run(worktreeKey);
    writeNode(setNodeStmt, worktreeKey, createRootDirectoryNode(baseTree));
  });

  return {
    kind: "sqlite",

    transact<T>(fn: () => T): T {
      return transactImpl(fn) as T;
    },

    readBaseTree(): SHA1 {
      const row = readBaseTreeStmt.get(worktreeKey);
      if (row === null) {
        throw new Error(`Virtual worktree not found: ${worktreeKey}`);
      }
      return readBaseTreeValue(row.base_tree);
    },

    writeBaseTree(baseTree: SHA1): void {
      upsertWorktreeStmt.run(worktreeKey, baseTree);
    },

    getNode(id: NodeId): WorktreeNode | null {
      const row = getNodeStmt.get(worktreeKey, id);
      if (row === null) {
        return null;
      }
      return readNode(row);
    },

    setNode(node: WorktreeNode): void {
      writeNode(setNodeStmt, worktreeKey, node);
    },

    deleteNode(id: NodeId): void {
      deleteNodeStmt.run(worktreeKey, id);
    },

    listChangeRecords(): readonly NormalizedChangeRecord[] {
      return listChangesStmt.all(worktreeKey).map(parseChangeRecordFromSqlite);
    },

    getChangeRecord(path: string): NormalizedChangeRecord | null {
      const row = getChangeStmt.get(worktreeKey, path);
      return row === null ? null : parseChangeRecordFromSqlite(row);
    },

    setChangeRecord(record: NormalizedChangeRecord): void {
      upsertChangeStmt.run(
        worktreeKey,
        record.path,
        record.previous?.kind ?? null,
        record.previous?.mode ?? null,
        record.previous?.hash ?? null,
        record.current?.kind ?? null,
        record.current?.mode ?? null,
        record.current?.hash ?? null,
      );
    },

    deleteChangeRecord(path: string): void {
      deleteChangeStmt.run(worktreeKey, path);
    },

    reset(baseTree: SHA1): void {
      resetTx(baseTree);
    },
  };
}

function ensureSchema(db: Database): void {
  const currentVersion = readSchemaVersion(db);
  const LEGACY_SCHEMA_VERSION = 7;
  if (
    currentVersion !== 0 &&
    currentVersion !== LEGACY_SCHEMA_VERSION &&
    currentVersion !== WORKTREE_SQLITE_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported virtual worktree SQLite schema version: expected ${WORKTREE_SQLITE_SCHEMA_VERSION}, got ${currentVersion}`,
    );
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS worktrees (
      worktree_key TEXT PRIMARY KEY,
      base_tree TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS worktree_nodes (
      worktree_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      origin_kind TEXT NOT NULL,
      origin_hash TEXT,
      origin_mode TEXT,
      state_kind TEXT NOT NULL,
      state_mode TEXT,
      content BLOB,
      target BLOB,
      directory_overlay TEXT,
      PRIMARY KEY (worktree_key, node_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS worktree_changes (
      worktree_key TEXT NOT NULL,
      path TEXT NOT NULL,
      previous_kind TEXT,
      previous_mode TEXT,
      previous_hash TEXT,
      current_kind TEXT,
      current_mode TEXT,
      current_hash TEXT,
      PRIMARY KEY (worktree_key, path)
    )
  `);

  if (currentVersion === LEGACY_SCHEMA_VERSION) {
    db.run(`DROP TABLE IF EXISTS worktree_dirty_dirs`);
  }

  if (currentVersion !== WORKTREE_SQLITE_SCHEMA_VERSION) {
    writeSchemaVersion(db, WORKTREE_SQLITE_SCHEMA_VERSION);
  }
}

function hasWorktree(db: Database, worktreeKey: string): boolean {
  const stmt = db.query<{ "1": number } | null, [string]>(
    "SELECT 1 FROM worktrees WHERE worktree_key = ?",
  );
  return stmt.get(worktreeKey) !== null;
}

function deleteWorktreeRows(db: Database, worktreeKey: string): void {
  const tx = db.transaction(() => {
    db.query<void, [string]>("DELETE FROM worktree_changes WHERE worktree_key = ?").run(
      worktreeKey,
    );
    db.query<void, [string]>("DELETE FROM worktree_nodes WHERE worktree_key = ?").run(worktreeKey);
    db.query<void, [string]>("DELETE FROM worktrees WHERE worktree_key = ?").run(worktreeKey);
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

function validateWorktreeIntegrity(db: Database, worktreeKey: string): void {
  const worktreeStmt = db.query<Pick<WorktreeRow, "base_tree"> | null, [string]>(
    "SELECT base_tree FROM worktrees WHERE worktree_key = ?",
  );
  const worktreeRow = worktreeStmt.get(worktreeKey);
  if (worktreeRow === null) {
    throw new Error(`Virtual worktree not found: ${worktreeKey}`);
  }
  readBaseTreeValue(worktreeRow.base_tree);

  const rootStmt = db.query<NodeRow | null, [string, string]>(
    `SELECT node_id, origin_kind, origin_hash, origin_mode, state_kind, state_mode, content, target, directory_overlay
     FROM worktree_nodes
     WHERE worktree_key = ? AND node_id = ?`,
  );
  const rootRow = rootStmt.get(worktreeKey, "root");
  if (rootRow === null) {
    throw new Error(`Virtual worktree is corrupted: missing root node for ${worktreeKey}`);
  }
  const rootNode = readNode(rootRow);
  if (rootNode.state.kind !== "directory") {
    throw new Error(
      `Virtual worktree is corrupted: root node is not a directory for ${worktreeKey}`,
    );
  }

  const allNodesStmt = db.query<NodeRow, [string]>(
    `SELECT node_id, origin_kind, origin_hash, origin_mode, state_kind, state_mode, content, target, directory_overlay
     FROM worktree_nodes
     WHERE worktree_key = ?`,
  );
  for (const row of allNodesStmt.all(worktreeKey)) {
    readNode(row);
  }
}

function writeNode(
  stmt: ReturnType<Database["query"]>,
  worktreeKey: string,
  node: WorktreeNode,
): void {
  if (node.state.kind === "directory") {
    stmt.run(
      worktreeKey,
      node.id,
      node.origin.kind,
      node.origin.kind === "none" ? null : node.origin.hash,
      node.origin.kind === "repo-blob" ? node.origin.mode : null,
      "directory",
      null,
      null,
      null,
      JSON.stringify(serializeDirectoryOverlayPayload(node.state.overlay)),
    );
    return;
  }

  if (node.state.kind === "file") {
    stmt.run(
      worktreeKey,
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
    worktreeKey,
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

function readNode(row: NodeRow): WorktreeNode {
  const origin = parseNodeOriginFromSqliteColumns(
    row.origin_kind,
    row.origin_hash,
    row.origin_mode,
  );

  if (row.state_kind === "directory") {
    if (row.state_mode !== null || row.content !== null || row.target !== null) {
      throw new Error("Invalid SQLite worktree directory node payload columns");
    }
    const overlay = parseDirectoryOverlay(row.directory_overlay);
    return {
      id: row.node_id as NodeId,
      origin,
      state: { kind: "directory", overlay },
    };
  }

  if (row.state_kind === "file") {
    if (row.state_mode !== "100644" && row.state_mode !== "100755") {
      throw new Error(`Invalid SQLite worktree node state mode: ${row.state_mode ?? "null"}`);
    }
    if (row.target !== null || row.directory_overlay !== null) {
      throw new Error("Invalid SQLite worktree file node payload columns");
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
    throw new Error(`Invalid SQLite worktree node state kind: ${row.state_kind}`);
  }
  if (row.state_mode !== "120000") {
    throw new Error(`Invalid SQLite worktree node state mode: ${row.state_mode ?? "null"}`);
  }
  if (row.content !== null || row.directory_overlay !== null) {
    throw new Error("Invalid SQLite worktree symlink node payload columns");
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

function readBlobColumn(raw: unknown, column: "content" | "target"): Buffer | undefined {
  if (raw === null) {
    return undefined;
  }
  if (!(raw instanceof Uint8Array)) {
    const ctorName =
      raw !== null && raw !== undefined && typeof raw === "object"
        ? (raw as object).constructor?.name
        : "N/A";
    throw new Error(
      `Invalid SQLite worktree ${column} column type: expected Uint8Array, got ${typeof raw} (constructor=${ctorName}, value=${JSON.stringify(raw)})`,
    );
  }
  return Buffer.from(raw);
}

function readBaseTreeValue(raw: unknown): SHA1 {
  if (typeof raw !== "string") {
    throw new Error("Invalid SQLite worktree base_tree");
  }
  try {
    return sha1(raw);
  } catch {
    throw new Error("Invalid SQLite worktree base_tree");
  }
}
