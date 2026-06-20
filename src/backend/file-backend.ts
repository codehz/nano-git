/**
 * 基于文件系统的仓库后端
 *
 * 将 .git 目录下的 loose objects、packfile 和引用存储
 * 组合为统一的 RepositoryBackend。
 */

import { createCompositeObjectStore } from "../pack/composite-store.ts";
import { createPackObjectStore } from "../pack/pack-store.ts";
import { createFileRefStore } from "../refs/index.ts";
import { createFileObjectStore } from "../store/index.ts";
import type { RepositoryBackend } from "./types.ts";

/** 创建文件系统仓库后端的可选参数 */
export interface CreateFileRepositoryBackendOptions {
  /**
   * 是否将 .git/objects/pack 下的 packfile 纳入读取路径
   *
   * 默认启用，使 openRepository() 能读取真实 Git 仓库中的 packed objects。
   */
  readonly includePack?: boolean;
}

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
export function createFileRepositoryBackend(
  gitDir: string,
  options: CreateFileRepositoryBackendOptions = {},
): RepositoryBackend {
  const looseObjects = createFileObjectStore(gitDir);
  const objects =
    options.includePack === false
      ? looseObjects
      : createCompositeObjectStore(looseObjects, createPackObjectStore(gitDir));

  return {
    gitDir,
    objects,
    refs: createFileRefStore(gitDir),
  };
}
