/**
 * 仓库打包与维护操作组装
 */

import { listReachableObjects } from "./reachability.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectStore } from "../odb/types.ts";
import type { RefStore } from "../refs/types.ts";
import type {
  RepositoryGCOptions,
  RepositoryPackSupport,
  RepositoryRepackOptions,
} from "./backend/index.ts";
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
  objects: ObjectStore,
  refs: RefStore,
  packs: RepositoryPackSupport | null,
): RepositoryMaintenanceOperations {
  function requirePacks(): RepositoryPackSupport {
    if (!packs) {
      throw new Error("Backend does not support packfile writes");
    }

    return packs;
  }

  return {
    writePack(hashes?: SHA1[]) {
      return requirePacks().writeFromSource(objects, hashes ?? objects.list());
    },

    repack(options?: RepositoryRepackOptions) {
      const packSupport = packs;
      if (!packSupport) {
        throw new Error("Backend does not support repack");
      }

      return packSupport.repack(objects, options);
    },

    listReachableObjects(): SHA1[] {
      return listReachableObjects(objects, refs);
    },

    gc(options?: RepositoryGCOptions) {
      const packSupport = packs;
      if (!packSupport) {
        throw new Error("Backend does not support gc");
      }

      return packSupport.gc(listReachableObjects(objects, refs), options);
    },
  };
}
