/**
 * 基于文件系统的仓库后端
 *
 * 将 .git 目录下的对象存储和引用存储组合为统一的 RepositoryBackend。
 */

import { createFileRefStore } from "../refs/index.ts";
import { createFileObjectStore } from "../store/index.ts";
import type { RepositoryBackend } from "./types.ts";

/**
 * 创建基于文件系统的仓库后端
 *
 * @param gitDir - .git 目录的路径
 *
 * @example
 * ```ts
 * const backend = createFileRepositoryBackend("/path/to/repo/.git");
 * const repo = createRepository(backend);
 * ```
 */
export function createFileRepositoryBackend(gitDir: string): RepositoryBackend {
  return {
    gitDir,
    objects: createFileObjectStore(gitDir),
    refs: createFileRefStore(gitDir),
  };
}
