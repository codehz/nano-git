/**
 * 基于内存的 Shallow 存储
 *
 * 适用于测试和临时操作场景。
 *
 * @example
 * ```ts
 * const store = createMemoryShallowStore();
 * store.write([hashA, hashB]);
 * ```
 */

import type { SHA1 } from "../../core/types.ts";
import type { ShallowStore, ShallowUpdate } from "./types.ts";

/**
 * 创建基于内存的 Shallow 存储
 *
 * @param initial - 初始 shallow 边界集合（可选）
 *
 * @example
 * ```ts
 * const store = createMemoryShallowStore([hashA]);
 * console.log(store.isShallow(hashA)); // true
 * ```
 */
export function createMemoryShallowStore(initial?: SHA1[]): ShallowStore {
  const shallowSet = new Set<SHA1>(initial ?? []);

  return {
    read(): SHA1[] {
      return Array.from(shallowSet).sort();
    },

    write(boundaries: SHA1[]): void {
      shallowSet.clear();
      for (const hash of boundaries) {
        shallowSet.add(hash);
      }
    },

    applyUpdate(update: ShallowUpdate): void {
      for (const hash of update.unshallow) {
        shallowSet.delete(hash);
      }
      for (const hash of update.shallow) {
        shallowSet.add(hash);
      }
    },

    isShallow(hash: SHA1): boolean {
      return shallowSet.has(hash);
    },
  };
}
