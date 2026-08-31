/**
 * Pack 仓库维护操作组装
 */

import type { RepositoryPackSupport } from "../../backend/pack.ts";
import type { RepositoryGCOptions } from "../../backend/types.ts";
import type { PackBuildResult, RepositoryRepackOptions } from "../../pack/types.ts";
import type { SHA1 } from "../../types/index.ts";
import type { PackRepository } from "../pack-types.ts";
import type { Repository } from "../types.ts";
import type { RewriteHistoryOptions } from "./rewrite-types.ts";

/**
 * 创建依赖 pack 支持的维护操作
 *
 * @param repository - 已创建的核心仓库
 * @param objects - 仓库对象数据库
 * @param packs - pack 后端能力
 * @returns pack 维护操作
 *
 * @example
 * ```ts
 * const packOps = createPackMaintenanceRepositoryOperations(repo, repo.objects, backend.packs);
 * ```
 */
export function createPackMaintenanceRepositoryOperations(
  repository: Repository,
  packs: RepositoryPackSupport,
): Pick<PackRepository, "packs" | "writePack" | "repack" | "gc" | "rewriteHistory"> {
  function writePack(hashes?: SHA1[]): PackBuildResult {
    return packs.writeFromSource(repository.objects, hashes ?? repository.objects.list());
  }

  function repack(options: RepositoryRepackOptions = {}): PackBuildResult {
    const hashes = options.hashes
      ? Array.from(options.hashes)
      : Array.from(repository.objects.list());
    const result = packs.repack(repository.objects, {
      hashes,
      replaceExistingPacks: options.replaceExistingPacks,
    });

    if (options.pruneLoose) {
      for (const hash of hashes) {
        repository.objects.delete?.(hash);
      }
    }

    packs.source.refresh();
    return result;
  }

  function gc(options?: RepositoryGCOptions): PackBuildResult {
    repository.gc(options);
    const hashes = repository.listReachableObjects();
    const result = packs.repack(repository.objects, {
      hashes,
      replaceExistingPacks: options?.replaceExistingPacks,
    });
    packs.source.refresh();
    return result;
  }

  function rewriteHistory(options?: RewriteHistoryOptions) {
    const result = repository.rewriteHistory(
      options?.pruneUnreachable ? { ...options, pruneUnreachable: false } : options,
    );
    if (!result.dryRun && options?.pruneUnreachable) {
      gc();
    }
    return result;
  }

  return {
    packs,
    writePack,
    repack,
    gc,
    rewriteHistory,
  };
}
