/**
 * 核心仓库维护操作组装
 *
 * 这里只处理与 pack 实现无关的可达性、GC 和历史重写。
 * Pack 仓库通过独立的 pack maintenance 组装器覆盖 GC 并增加 repack 能力。
 */

import { listReachableObjects } from "./reachability.ts";
import { rewriteHistory as rewriteHistoryImpl } from "./rewrite-history.ts";

import type { RepositoryGCOptions } from "../../backend/types.ts";
import type { ObjectDatabase } from "../../odb/types.ts";
import type { RefStore } from "../../types/refs.ts";
import type { RepositoryMaintenanceOperations } from "./maintenance-types.ts";
import type { RewriteHistoryOptions, RewriteHistoryResult } from "./rewrite-types.ts";

/**
 * 创建核心仓库维护相关操作
 *
 * @example
 * ```ts
 * const ops = createMaintenanceRepositoryOperations(objects, refs);
 * ops.gc();
 * ```
 */
export function createMaintenanceRepositoryOperations(
  objects: ObjectDatabase,
  refs: RefStore,
): RepositoryMaintenanceOperations {
  function gc(options?: RepositoryGCOptions): void {
    const reachable = listReachableObjects(objects, refs);
    if (options?.pruneLoose ?? true) {
      const reachableSet = new Set(reachable);
      for (const hash of objects.list()) {
        if (!reachableSet.has(hash)) {
          objects.delete?.(hash);
        }
      }
    }
  }

  return {
    listReachableObjects() {
      return listReachableObjects(objects, refs);
    },

    gc,

    rewriteHistory(options?: RewriteHistoryOptions): RewriteHistoryResult {
      const result = rewriteHistoryImpl(objects, refs, options);
      if (!result.dryRun && options?.pruneUnreachable) {
        gc();
      }
      return result;
    },
  };
}
