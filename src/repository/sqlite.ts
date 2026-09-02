/**
 * SQLite 仓库便捷创建函数
 *
 * 一键创建基于已打开 SQLite 连接的持久化 Git 仓库。
 * 内部组合 createSqliteRepositoryBackend + createRepository。
 * 数据库连接生命周期由调用方管理。
 *
 * @example
 * ```ts
 * import { Database } from "bun:sqlite";
 * import { createSqliteRepository } from "nano-git/repository/sqlite";
 * import type { SqliteDatabase } from "nano-git/types/sqlite";
 *
 * const db = new Database("/tmp/cache.sqlite") as unknown as SqliteDatabase;
 * const repo = createSqliteRepository(db);
 * const hash = repo.writeBlob(Uint8Array.from("hello world"));
 * ```
 */

import { createSqliteRepositoryBackend } from "../backend/sqlite.ts";
import { createRepository } from "./create.ts";

import type { CreateSqliteRepositoryBackendOptions } from "../backend/sqlite.ts";
import type { SqliteDatabase } from "../types/sqlite.ts";
import type { Repository } from "./types.ts";

export type { SqliteDatabase, SqliteStatement, SqliteValue } from "../types/sqlite.ts";
export type { CreateSqliteRepositoryBackendOptions } from "../backend/sqlite.ts";

/**
 * 创建基于已打开 SQLite 连接的持久化仓库
 *
 * 相比直接使用 createSqliteRepositoryBackend + createRepository，
 * 此函数提供了更简洁的一步到位接口。不关闭传入的 `db`。
 *
 * @param db - 已打开的 SQLite 数据库
 * @param options - 可选参数（如 gitDir）
 * @returns 仓库实例
 *
 * @example
 * ```ts
 * import { Database } from "bun:sqlite";
 * import type { SqliteDatabase } from "nano-git/types/sqlite";
 *
 * const db = new Database("/tmp/repo.sqlite") as unknown as SqliteDatabase;
 * const repo = createSqliteRepository(db);
 * repo.createBranch("main", repo.createTree([]));
 * repo.writeBlob(Uint8Array.from("data"));
 * ```
 */
export function createSqliteRepository(
  db: SqliteDatabase,
  options?: CreateSqliteRepositoryBackendOptions,
): Repository {
  const backend = createSqliteRepositoryBackend(db, options);
  return createRepository(backend);
}
