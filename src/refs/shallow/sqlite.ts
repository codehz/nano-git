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

import { sha1 } from "../../core/types.ts";

import type { SHA1 } from "../../core/types.ts";
import type { ShallowStore, ShallowUpdate } from "../../core/types/shallow.ts";
import type { Database } from "bun:sqlite";

/**
 * 创建基于 SQLite 的 shallow 边界存储
 *
 * @param db - 已打开的 bun:sqlite Database 实例
 * @returns 符合 ShallowStore 接口的存储后端
 *
 * @example
 * ```ts
 * import { Database } from "bun:sqlite";
 * const db = new Database("/tmp/repo.sqlite");
 * const store = createSqliteShallowStore(db);
 *
 * store.write([hashA, hashB]);
 * console.log(store.isShallow(hashA)); // true
 * ```
 */
export function createSqliteShallowStore(db: Database): ShallowStore {
  const selectAllStmt = db.query<{ hash: string }, []>("SELECT hash FROM shallow ORDER BY hash");
  const selectExistsStmt = db.query<{ "1": number }, [string]>(
    "SELECT 1 FROM shallow WHERE hash = ?",
  );
  const deleteAllStmt = db.query<void, []>("DELETE FROM shallow");
  const insertStmt = db.query<void, [string]>("INSERT OR IGNORE INTO shallow (hash) VALUES (?)");
  const deleteOneStmt = db.query<void, [string]>("DELETE FROM shallow WHERE hash = ?");

  /** 全量替换事务 */
  const replaceAllTx = db.transaction((boundaries: SHA1[]) => {
    deleteAllStmt.run();
    for (const hash of boundaries) {
      insertStmt.run(hash);
    }
  });

  /** 增量更新事务 */
  const applyUpdateTx = db.transaction((update: ShallowUpdate) => {
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
