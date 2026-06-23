/**
 * 仓库后端模块
 *
 * 统一导出 RepositoryBackend 接口及常用实现。
 */

export type {
  PackRepackOptions,
  RepositoryBackend,
  RepositoryGCOptions,
  RepositoryPackSupport,
  RepositoryRepackOptions,
} from "./types.ts";

export type { ShallowStore, ShallowUpdate } from "../../shallow/types.ts";
export {
  createMemoryRepositoryBackend,
  type CreateMemoryRepositoryBackendOptions,
} from "./memory-backend.ts";
export {
  createFileRepositoryBackend,
  type CreateFileRepositoryBackendOptions,
} from "./file-backend.ts";
