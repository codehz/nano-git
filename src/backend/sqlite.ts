/**
 * 基于 SQLite 的仓库后端
 *
 * 将 SQLite 中的 objects、refs、shallow 存储
 * 组合为统一的 RepositoryBackend。
 *
 * 支持 [Symbol.dispose]() 释放数据库连接，
 * 可使用 `using` 语法管理生命周期。
 */

import { Database } from "bun:sqlite";

import { HEAD_REF, HEADS_PREFIX } from "../core/types/refs.ts";
import { createSqliteObjectStore } from "../odb/sqlite.ts";
import { createSqliteShallowStore } from "../refs/shallow/sqlite.ts";
import { createSqliteRefStore } from "../refs/sqlite.ts";

import type { RepositoryBackend } from "./types.ts";

/** 创建 SQLite 仓库后端的可选参数 */
export interface CreateSqliteRepositoryBackendOptions {
  /** 开启 WAL 模式，默认 true */
  readonly walMode?: boolean;
}

/**
 * SQLite 仓库后端（含资源释放能力）
 *
 * 在 RepositoryBackend 的基础上增加了 [Symbol.dispose]()，
 * 支持 `using backend = createSqliteRepositoryBackend(...)` 语法。
 */
export interface SqliteRepositoryBackend extends RepositoryBackend {
  /** 释放 SQLite 数据库连接 */
  [Symbol.dispose](): void;
}

/**
 * 创建基于 SQLite 文件的完整仓库后端
 *
 * 内部创建 Database 实例并组合三个子 store。
 * 返回的 backend 实现了 [Symbol.dispose]()，可使用 `using` 语法
 * 或在不再使用时手动调用 `backend[Symbol.dispose]()`。
 *
 * @param dbPath - SQLite 数据库文件路径
 * @returns 实现了 SqliteRepositoryBackend 的仓库后端（可用 `using` 管理）
 *
 * @example
 * ```ts
 * // 使用 using 自动释放（推荐）
 * using backend = createSqliteRepositoryBackend("/tmp/repo.sqlite");
 * const repo = createRepository(backend);
 *
 * // 或手动管理
 * const backend = createSqliteRepositoryBackend("/tmp/repo.sqlite");
 * const repo = createRepository(backend);
 * // ... 使用完毕 ...
 * backend[Symbol.dispose]();
 * ```
 */
export function createSqliteRepositoryBackend(
  dbPath: string,
  options: CreateSqliteRepositoryBackendOptions = {},
): SqliteRepositoryBackend {
  const db = new Database(dbPath);

  if (options.walMode !== false) {
    db.run("PRAGMA journal_mode = WAL");
  }

  // 确保表结构存在
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
    gitDir: dbPath,
    objects: createSqliteObjectStore(db),
    refs: createSqliteRefStore(db),
    shallow: createSqliteShallowStore(db),
    packs: null,

    /** 释放 SQLite 数据库连接 */
    [Symbol.dispose](): void {
      db.close();
    },
  };
}
