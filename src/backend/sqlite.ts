/**
 * 基于 SQLite 的仓库后端
 *
 * 将 SQLite 中的 objects、refs、shallow 存储
 * 组合为统一的 RepositoryBackend。
 *
 * 数据库连接由调用方注入并自行管理生命周期。
 */

import { createSqliteObjectStore } from "../odb/sqlite.ts";
import { createSqliteShallowStore } from "../refs/shallow/sqlite.ts";
import { createSqliteRefStore } from "../refs/sqlite.ts";
import { HEAD_REF, HEADS_PREFIX } from "../types/refs.ts";

import type { SqliteDatabase } from "../types/sqlite.ts";
import type { RepositoryBackend } from "./types.ts";

export type { SqliteDatabase, SqliteStatement, SqliteValue } from "../types/sqlite.ts";

/** 创建 SQLite 仓库后端的可选参数 */
export interface CreateSqliteRepositoryBackendOptions {
  /**
   * 逻辑 gitDir 标识
   *
   * SQLite 后端没有真实 `.git` 目录；默认 `""`。
   */
  readonly gitDir?: string;
}

/**
 * 创建基于已打开 SQLite 连接的完整仓库后端
 *
 * 会幂等创建 objects / refs / shallow 表，并初始化 HEAD。
 * 不关闭传入的 `db`，生命周期由调用方负责。
 *
 * @param db - 已打开的 SQLite 数据库
 * @param options - 可选参数（如 gitDir）
 * @returns RepositoryBackend
 *
 * @example
 * ```ts
 * import { Database } from "bun:sqlite";
 * import { createSqliteRepositoryBackend } from "nano-git/backend/sqlite";
 * import { createRepository } from "nano-git/repository/core";
 * import type { SqliteDatabase } from "nano-git/types/sqlite";
 *
 * const db = new Database("/tmp/repo.sqlite") as unknown as SqliteDatabase;
 * const backend = createSqliteRepositoryBackend(db);
 * const repo = createRepository(backend);
 * ```
 */
export function createSqliteRepositoryBackend(
  db: SqliteDatabase,
  options: CreateSqliteRepositoryBackendOptions = {},
): RepositoryBackend {
  // 确保表结构存在（幂等，重复打开同一数据库不会重复创建）
  db.run(
    "CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, type TEXT NOT NULL, content BLOB NOT NULL)",
  );
  db.run("CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, target TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS shallow (hash TEXT PRIMARY KEY)");

  // 初始化 HEAD
  db.run("INSERT OR IGNORE INTO refs (name, target) VALUES (?, ?)", [
    HEAD_REF,
    `ref: ${HEADS_PREFIX}main`,
  ]);

  return {
    gitDir: options.gitDir ?? "",
    objects: createSqliteObjectStore(db),
    refs: createSqliteRefStore(db),
    shallow: createSqliteShallowStore(db),
    packs: null,
  };
}
