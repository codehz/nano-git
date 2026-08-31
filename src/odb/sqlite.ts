/**
 * 基于 SQLite 的对象数据库（raw-first）
 *
 * 所有对象存储在 SQLite 数据库的 objects 表中。
 * 使用 INSERT OR IGNORE 实现幂等写入，使用 db.transaction() 实现批量原子写入。
 *
 * 表创建由上层 createSqliteRepositoryBackend 负责，
 * 本模块只操作已存在的表，不负责 DDL。
 */

import { ObjectHashMismatchError, ObjectNotFoundError } from "../errors.ts";
import { hashObject } from "../hash/index.ts";
import { sha1 } from "../types/index.ts";

import type { RawGitObject, SHA1, ObjectType } from "../types/index.ts";
import type { SqliteDatabase } from "../types/sqlite.ts";
import type { ObjectDatabase } from "./types.ts";

// 数据库查询结果行类型
interface ObjectRow {
  hash: string;
  type: string;
  content: Uint8Array;
}

/**
 * 创建基于 SQLite 的对象数据库
 *
 * @param db - 已打开的 SQLite 数据库（需已有 objects 表）
 * @returns 符合 ObjectDatabase 接口的存储后端
 *
 * @example
 * ```ts
 * import { Database } from "bun:sqlite";
 * import { createSqliteObjectStore } from "nano-git/odb/sqlite";
 * import type { SqliteDatabase } from "nano-git/types/sqlite";
 *
 * const db = new Database(":memory:") as unknown as SqliteDatabase;
 * db.run(
 *   "CREATE TABLE objects (hash TEXT PRIMARY KEY, type TEXT NOT NULL, content BLOB NOT NULL)",
 * );
 * const store = createSqliteObjectStore(db);
 * store.ingest(raw);
 * ```
 */
export function createSqliteObjectStore(db: SqliteDatabase): ObjectDatabase {
  const selectStmt = db.query<ObjectRow>("SELECT hash, type, content FROM objects WHERE hash = ?");
  const existsStmt = db.query<{ "1": number }>("SELECT 1 FROM objects WHERE hash = ?");
  const insertStmt = db.query(
    "INSERT OR IGNORE INTO objects (hash, type, content) VALUES (?, ?, ?)",
  );
  const deleteStmt = db.query("DELETE FROM objects WHERE hash = ?");
  const listStmt = db.query<Pick<ObjectRow, "hash">>("SELECT hash FROM objects ORDER BY hash");

  /** 批量插入的事务包装 */
  const ingestManyTx = db.transaction((objects: Iterable<RawGitObject>) => {
    for (const raw of objects) {
      const expectedHash = hashObject(raw.type, raw.content);
      if (expectedHash !== raw.hash) {
        throw new ObjectHashMismatchError(expectedHash, raw.hash);
      }
      insertStmt.run(raw.hash, raw.type, raw.content);
    }
  });

  return {
    ingest(raw: RawGitObject): void {
      const expectedHash = hashObject(raw.type, raw.content);
      if (expectedHash !== raw.hash) {
        throw new ObjectHashMismatchError(expectedHash, raw.hash);
      }
      insertStmt.run(raw.hash, raw.type, raw.content);
    },

    ingestMany(objects: Iterable<RawGitObject>): void {
      ingestManyTx(objects);
    },

    read(hash: SHA1): RawGitObject {
      const row = selectStmt.get(hash);
      if (!row) {
        throw new ObjectNotFoundError(hash, { operation: "read", source: "sqlite" });
      }
      return {
        hash: sha1(row.hash),
        type: row.type as ObjectType,
        content: Buffer.from(row.content),
      };
    },

    tryRead(hash: SHA1): RawGitObject | undefined {
      const row = selectStmt.get(hash);
      if (!row) {
        return undefined;
      }
      return {
        hash: sha1(row.hash),
        type: row.type as ObjectType,
        content: Buffer.from(row.content),
      };
    },

    exists(hash: SHA1): boolean {
      return existsStmt.get(hash) !== null;
    },

    list(): SHA1[] {
      return listStmt.all().map((row) => sha1(row.hash));
    },

    delete(hash: SHA1): void {
      deleteStmt.run(hash);
    },
  };
}
