/**
 * nano-git 使用的最小 SQLite 接口
 *
 * 不绑定具体驱动（`bun:sqlite` / `node:sqlite` / better-sqlite3 适配层等），
 * 由调用方注入已打开的数据库实例。仅声明本库实际用到的方法。
 */

/** 可绑定到 SQL 参数的值 */
export type SqliteValue = null | number | bigint | string | boolean | Uint8Array;

/**
 * 预编译语句
 *
 * `get` 在无匹配行时返回 `null`。
 */
export interface SqliteStatement<TRow = unknown> {
  get(...params: SqliteValue[]): TRow | null;
  all(...params: SqliteValue[]): TRow[];
  run(...params: SqliteValue[]): unknown;
}

/**
 * SQLite 数据库连接
 *
 * @example
 * ```ts
 * import { Database } from "bun:sqlite";
 * import type { SqliteDatabase } from "nano-git/types/sqlite";
 * import { createSqliteRepository } from "nano-git/repository/sqlite";
 *
 * const db = new Database(":memory:") as unknown as SqliteDatabase;
 * const repo = createSqliteRepository(db);
 * ```
 */
export interface SqliteDatabase {
  run(sql: string, params?: readonly SqliteValue[]): unknown;
  query<TRow = unknown>(sql: string): SqliteStatement<TRow>;
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult;
}
