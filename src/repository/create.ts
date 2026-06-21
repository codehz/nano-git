/**
 * 仓库实例创建逻辑
 */

import { push as transportPush } from "../transport/push.ts";
import { createMaintenanceRepositoryOperations } from "./maintenance-operations.ts";
import { createObjectRepositoryOperations } from "./object-operations.ts";
import { createRefRepositoryOperations } from "./ref-operations.ts";
import { createRemoteRepositoryOperations } from "./remote-operations.ts";

import type { PushOptions, PushResult } from "../transport/types.ts";
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

  const remoteOps = createRemoteRepositoryOperations(backend);

  return {
    backend,
    objects,
    refs,
    packs,
    gitDir,
    ...createObjectRepositoryOperations(objects),
    ...createRefRepositoryOperations(backend),
    ...createMaintenanceRepositoryOperations(objects, refs, packs),
    ...remoteOps,
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
