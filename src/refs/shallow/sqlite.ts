/**
 * 基于 SQLite 的 Shallow 存储
 *
 * 所有 shallow 边界存储在 SQLite 数据库的 shallow 表中。
 * write 使用 DELETE + INSERT 全量替换模式（与 memory/file 后端一致）。
 * applyUpdate 使用 SQL 事务做增量更新。
 *
 * 表创建由上层 createSqliteRepositoryBackend 负责，
 * 本模块只操作已存在的表，不负责 DDL。
 */

import { sha1 } from "../../types/index.ts";

import type { SqliteConnectionHandle } from "../../backend/sqlite-pool.ts";
import type { SHA1 } from "../../types/index.ts";
import type { ShallowStore, ShallowUpdate } from "../../types/shallow.ts";

/**
 * 创建基于 SQLite 的 shallow 边界存储
 *
 * @param conn - SQLite 连接池句柄（含 statement 缓存）
 * @returns 符合 ShallowStore 接口的存储后端
 *
 * @example
 * ```ts
 * import { acquireConnection } from "nano-git/backend/sqlite";
 * using conn = acquireConnection("/tmp/repo.sqlite");
 * const store = createSqliteShallowStore(conn);
 *
 * store.write([hashA, hashB]);
 * console.log(store.isShallow(hashA)); // true
 * ```
 */
export function createSqliteShallowStore(conn: SqliteConnectionHandle): ShallowStore {
  const selectAllStmt = conn.prepare<{ hash: string }>("SELECT hash FROM shallow ORDER BY hash");
  const selectExistsStmt = conn.prepare<{ "1": number }>("SELECT 1 FROM shallow WHERE hash = ?");
  const deleteAllStmt = conn.prepare<void>("DELETE FROM shallow");
  const insertStmt = conn.prepare<void>("INSERT OR IGNORE INTO shallow (hash) VALUES (?)");
  const deleteOneStmt = conn.prepare<void>("DELETE FROM shallow WHERE hash = ?");

  /** 全量替换事务 */
  const replaceAllTx = conn.db.transaction((boundaries: SHA1[]) => {
    deleteAllStmt.run();
    for (const hash of boundaries) {
      insertStmt.run(hash);
    }
  });

  /** 增量更新事务 */
  const applyUpdateTx = conn.db.transaction((update: ShallowUpdate) => {
    for (const hash of update.unshallow) {
      deleteOneStmt.run(hash);
    }
    for (const hash of update.shallow) {
      insertStmt.run(hash);
    }
  });

  return {
    read(): SHA1[] {
      return selectAllStmt.all().map((row) => sha1(row.hash));
    },

    write(boundaries: SHA1[]): void {
      replaceAllTx(boundaries);
    },

    applyUpdate(update: ShallowUpdate): void {
      applyUpdateTx(update);
    },

    isShallow(hash: SHA1): boolean {
      return selectExistsStmt.get(hash) !== null;
    },
  };
}
