/**
 * 基于内存的 Refs 存储
 */

import { RefNotFoundError } from "../../core/errors.ts";
import { validateRefName, validateRefPrefix } from "../names.ts";

import type { RefStore } from "../types.ts";

/**
 * 创建基于内存的 Refs 存储
 *
 * @example
 * ```ts
 * const store = createMemoryRefStore();
 * ```
 */
export function createMemoryRefStore(initial?: Map<string, string>): RefStore {
  const store = new Map(initial);

  return {
    read(ref: string): string | null {
      validateRefName(ref);
      return store.get(ref) ?? null;
    },

    write(ref: string, content: string): void {
      validateRefName(ref);
      store.set(ref, content.trimEnd());
    },

    delete(ref: string): void {
      validateRefName(ref);
      if (!store.has(ref)) {
        throw new RefNotFoundError(ref);
      }

      store.delete(ref);
    },

    list(prefix: string): string[] {
      validateRefPrefix(prefix);
      return Array.from(store.keys())
        .filter((key) => key.startsWith(prefix))
        .sort();
    },

    listAll(): string[] {
      return Array.from(store.keys())
        .filter((key) => key.startsWith("refs/"))
        .sort();
    },
  };
}
