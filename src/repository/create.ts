/**
 * 仓库实例创建逻辑
 */

import { fetch as transportFetch } from "../transport/fetch.ts";
import { push as transportPush } from "../transport/push.ts";
import { createMaintenanceRepositoryOperations } from "./maintenance-operations.ts";
import { createObjectRepositoryOperations } from "./object-operations.ts";
import { createRefRepositoryOperations } from "./ref-operations.ts";

import type { FetchOptions, FetchResult, PushOptions, PushResult } from "../transport/types.ts";
import type { RepositoryBackend } from "./backend/index.ts";
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
      // 从 shallow store 读取当前状态，自动传入 transport 层
      const currentShallow = backend.shallow.read();
      const effectiveOptions: FetchOptions = {
        ...options,
        shallow: options?.shallow ?? (currentShallow.length > 0 ? currentShallow : undefined),
      };

      const result = await transportFetch(objects, refs, url, effectiveOptions);

      // fetch 成功后，将 shallow/unshallow 变更持久化到 shallow store
      if ((result.shallow ?? []).length > 0 || (result.unshallow ?? []).length > 0) {
        backend.shallow.applyUpdate({
          shallow: result.shallow ?? [],
          unshallow: result.unshallow ?? [],
        });
      }

      return result;
    },
    async push(url: string, options?: PushOptions): Promise<PushResult> {
      // 读取当前 shallow 状态，传递给 transport push 层
      const currentShallow = backend.shallow.read();
      const effectiveOptions: PushOptions = {
        ...options,
        shallowBoundaries:
          options?.shallowBoundaries ?? (currentShallow.length > 0 ? currentShallow : undefined),
      };

      return transportPush(objects, refs, url, effectiveOptions);
    },
  };
}
