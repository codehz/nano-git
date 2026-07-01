/**
 * 仓库打包与维护操作组装
 *
 * GC 编排策略：
 * 1. 如果有 pack 支持，先 repack 可达对象（替换旧 pack）
 * 2. 如果后端 ObjectDatabase 支持 delete，清理不可达的 loose 对象
 * 3. 刷新 pack 视图
 *
 * 不再依赖 RepositoryPackSupport.gc()——GC 是仓库层的编排职责，
 * RepositoryPackSupport 只负责 packfile 层面的读写。
 */

import { listReachableObjects } from "./reachability.ts";

import type {
  RepositoryGCOptions,
  RepositoryPackSupport,
  RepositoryRepackOptions,
} from "../../backend/types.ts";
import type { ObjectDatabase } from "../../odb/types.ts";
import type { PackBuildResult } from "../../pack/builder/pack-builder.ts";
import type { SHA1 } from "../../types/index.ts";
import type { RefStore } from "../../types/refs.ts";
import type { RepositoryMaintenanceOperations } from "./maintenance-types.ts";

/**
 * 创建仓库维护相关操作
 *
 * @example
 * ```ts
 * const ops = createMaintenanceRepositoryOperations(objects, refs, packs);
 * const reachable = ops.listReachableObjects();
 * ```
 */
export function createMaintenanceRepositoryOperations(
  objects: ObjectDatabase,
  refs: RefStore,
  packs: RepositoryPackSupport | null,
): RepositoryMaintenanceOperations {
  return {
    writePack(hashes?: SHA1[]) {
      if (!packs) {
        throw new Error("Backend does not support packfile writes");
      }
      return packs.writeFromSource(objects, hashes ?? objects.list());
    },

    repack(options?: RepositoryRepackOptions) {
      if (!packs) {
        throw new Error("Backend does not support repack");
      }

      const hashes = options?.hashes ? Array.from(options.hashes) : Array.from(objects.list());
      const result = packs.repack(objects, {
        hashes,
        replaceExistingPacks: options?.replaceExistingPacks,
      });

      // pruneLoose 由仓库层处理，不交给 packs.repack
      if (options?.pruneLoose) {
        for (const hash of hashes) {
          objects.delete?.(hash);
        }
      }

      packs.source.refresh();
      return result;
    },

    listReachableObjects(): SHA1[] {
      return listReachableObjects(objects, refs);
    },

    gc(options?: RepositoryGCOptions): PackBuildResult | undefined {
      const reachable = listReachableObjects(objects, refs);
      const reachableSet = new Set(reachable);

      // 1. 有 pack 支持时，repack 可达对象（自动替换旧 pack）
      let result: PackBuildResult | undefined;
      if (packs) {
        result = packs.repack(objects, {
          hashes: reachable,
          replaceExistingPacks: options?.replaceExistingPacks,
        });
        packs.source.refresh();
      }

      // 2. 删除不可达对象（如果后端支持）
      if (options?.pruneLoose ?? true) {
        for (const hash of objects.list()) {
          if (!reachableSet.has(hash)) {
            objects.delete?.(hash);
          }
        }
      }

      return result;
    },
  };
}
