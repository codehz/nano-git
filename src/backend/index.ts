/**
 * 仓库后端模块
 *
 * 仅导出后端抽象类型。
 *
 * 具体实现请使用：
 * - `nano-git/backend/memory`
 * - `nano-git/backend/file`
 */

export type {
  PackRepackOptions,
  RepositoryBackend,
  RepositoryGCOptions,
  RepositoryPackSupport,
  RepositoryRepackOptions,
} from "./types.ts";
