/**
 * SQLite 仓库便捷创建函数
 *
 * 一键创建基于 SQLite 的持久化 Git 仓库。
 * 内部组合 createSqliteRepositoryBackend + createRepository，
 * 返回的 repo 自带 [Symbol.dispose]()，可用 `using` 管理生命周期。
 *
 * @example
 * ```ts
 * import { createSqliteRepository } from "nano-git/repository/sqlite";
 *
 * using repo = createSqliteRepository("/tmp/cache.sqlite");
 * const hash = repo.writeBlob(Buffer.from("hello world"));
 * // 作用域结束时自动 db.close()
 * ```
 */

import { createSqliteRepositoryBackend } from "../backend/sqlite.ts";
import { createRepository } from "./create.ts";

import type { CreateSqliteRepositoryBackendOptions } from "../backend/sqlite.ts";
import type { Repository } from "./types.ts";

/**
 * 创建基于 SQLite 文件的持久化仓库
 *
 * 相比直接使用 createSqliteRepositoryBackend + createRepository，
 * 此函数提供了更简洁的一步到位接口。
 *
 * @param dbPath - SQLite 数据库文件路径
 * @param options - 可选参数（如 walMode）
 * @returns 仓库实例（附带 [Symbol.dispose]()，可用 `using` 管理）
 *
 * @example
 * ```ts
 * // 使用 using 自动释放（推荐）
 * using repo = createSqliteRepository("/tmp/repo.sqlite");
 * repo.createBranch("main", repo.createTree([]));
 * repo.writeBlob(Buffer.from("data"));
 * // 作用域结束时自动关闭数据库连接
 * ```
 */
export function createSqliteRepository(
  dbPath: string,
  options?: CreateSqliteRepositoryBackendOptions,
): Repository & { [Symbol.dispose](): void } {
  const backend = createSqliteRepositoryBackend(dbPath, options);
  const repo = createRepository(backend);
  return Object.assign(repo, { [Symbol.dispose]: () => backend[Symbol.dispose]() });
}
