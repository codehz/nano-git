/**
 * 基于内存的 Refs 存储（用于测试）
 *
 * 所有引用存储在内存 Map 中，程序退出后丢失。
 * 适用于单元测试和临时操作场景。
 */

import type { RefStore } from "./types.ts";
import { RefNotFoundError } from "../errors.ts";
import { validateRefName, validateRefPrefix } from "./utils.ts";

/**
 * 创建基于内存的 Refs 存储
 *
 * @param initial - 初始引用内容（可选），用于设置默认 HEAD 等
 *
 * @example
 * ```ts
 * const refStore = createMemoryRefStore();
 * refStore.writeRaw("refs/heads/main", "abc123...");
 * const content = refStore.readRaw("refs/heads/main");
 * ```
 */
export function createMemoryRefStore(initial?: Map<string, string>): RefStore {
  const store = new Map(initial);

  return {
    readRaw(ref: string): string | null {
      validateRefName(ref);
      return store.get(ref) ?? null;
    },

    writeRaw(ref: string, content: string): void {
      validateRefName(ref);
      store.set(ref, content.trimEnd());
    },

    deleteRaw(ref: string): void {
      validateRefName(ref);
      if (!store.has(ref)) {
        throw new RefNotFoundError(ref);
      }

      store.delete(ref);
    },

    listRaw(prefix: string): string[] {
      validateRefPrefix(prefix);
      return Array.from(store.keys())
        .filter((key) => key.startsWith(prefix))
        .sort();
    },
  };
}
