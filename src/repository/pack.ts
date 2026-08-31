/**
 * Pack 仓库组合入口
 *
 * 在核心 Repository 上增加非空 pack 支持。
 */

import { createRepository } from "./create.ts";
import { createPackMaintenanceRepositoryOperations } from "./ops/pack-maintenance-operations.ts";

import type { RepositoryPackBackend } from "../backend/pack.ts";
import type { PackRepository } from "./pack-types.ts";
import type { Repository } from "./types.ts";

/**
 * 基于 Pack backend 创建仓库
 *
 * @param backend - 必须提供 pack 支持的仓库后端
 * @returns 带 pack 能力的仓库
 *
 * @example
 * ```ts
 * const backend = createFileRepositoryBackend("/tmp/repo");
 * const repo = createPackRepository(backend);
 * repo.repack();
 * ```
 */
export function createPackRepository(backend: RepositoryPackBackend): PackRepository {
  const repository: Repository = createRepository(backend);
  return {
    ...repository,
    ...createPackMaintenanceRepositoryOperations(repository, backend.packs),
  };
}

export type { PackRepository } from "./pack-types.ts";
