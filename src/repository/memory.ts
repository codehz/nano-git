/**
 * 内存仓库便捷创建函数
 *
 * 一键创建完全在内存中的 Git 仓库，无需任何文件系统操作。
 * 适用于测试和临时操作场景。
 *
 * @example
 * ```ts
 * import { createMemoryRepository } from "nano-git/repository/memory";
 *
 * const repo = createMemoryRepository();
 * const hash = repo.writeBlob(Buffer.from("hello world"));
 * ```
 */

import { createMemoryRepositoryBackend } from "./backend/index.ts";
import { createRepository } from "./create.ts";

import type { Repository } from "./types.ts";

/**
 * 创建内存仓库
 *
 * @returns 仓库实例
 *
 * @example
 * ```ts
 * const repo = createMemoryRepository();
 * repo.createBranch("main", repo.createTree([]));
 * ```
 */
export function createMemoryRepository(): Repository {
  return createRepository(createMemoryRepositoryBackend());
}
