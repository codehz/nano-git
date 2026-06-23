/**
 * 仓库实例创建逻辑
 */

import { createRepoImportOperations } from "./import/import-session.ts";
import { createFetchRepositoryOperations } from "./ops/fetch-operations.ts";
import { createMaintenanceRepositoryOperations } from "./ops/maintenance-operations.ts";
import { createObjectRepositoryOperations } from "./ops/object-operations.ts";
import { createPushRepositoryOperations } from "./ops/push-operations.ts";
import { createRefRepositoryOperations } from "./ops/ref-operations.ts";

import type { RepositoryBackend } from "../backend/index.ts";
import type { Repository } from "./types.ts";

/**
 * 基于显式后端创建仓库实例
 *
 * Repository 不负责拼装 ObjectStore / RefStore，
 * 调用方需要显式提供统一的 RepositoryBackend。
 *
 * @param backend - 仓库后端
 * @returns 仓库实例
 *
 * @example
 * ```ts
 * const backend = createMemoryRepositoryBackend();
 * const repo = createRepository(backend);
 * ```
 */
export function createRepository(backend: RepositoryBackend): Repository {
  const { objects, refs, packs, shallow, gitDir } = backend;

  return {
    objects,
    refs,
    packs,
    shallow,
    gitDir,
    ...createObjectRepositoryOperations(objects),
    ...createRefRepositoryOperations(backend),
    ...createMaintenanceRepositoryOperations(objects, refs, packs),
    ...createPushRepositoryOperations(backend),
    ...createFetchRepositoryOperations(backend),
    ...createRepoImportOperations(backend),
  };
}
