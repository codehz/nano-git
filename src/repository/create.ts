/**
 * 仓库实例创建逻辑
 */

import type { RepositoryBackend } from "./backend/index.ts";
import type { Repository } from "./types.ts";
import { createMaintenanceRepositoryOperations } from "./maintenance-operations.ts";
import { createObjectRepositoryOperations } from "./object-operations.ts";
import { createRefRepositoryOperations } from "./ref-operations.ts";
import { fetch as transportFetch } from "../transport/fetch.ts";
import type { FetchOptions, FetchResult } from "../transport/types.ts";

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
  const { objects, refs, packs, gitDir } = backend;

  return {
    backend,
    objects,
    refs,
    packs,
    gitDir,
    ...createObjectRepositoryOperations(objects),
    ...createRefRepositoryOperations(backend),
    ...createMaintenanceRepositoryOperations(objects, refs, packs),
    async fetch(url: string, options?: FetchOptions): Promise<FetchResult> {
      return transportFetch(objects, refs, url, options);
    },
  };
}
