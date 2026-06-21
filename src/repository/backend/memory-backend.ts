/**
 * 基于内存的仓库后端
 *
 * 适用于测试和临时操作场景。
 */

import { createMemoryObjectStore } from "../../odb/index.ts";
import { createMemoryRefStore, HEAD_REF, HEADS_PREFIX } from "../../refs/index.ts";

import type { SHA1 } from "../../core/types.ts";
import type { RepositoryBackend, ShallowUpdate } from "./types.ts";

/** 创建内存仓库后端的可选参数 */
export interface CreateMemoryRepositoryBackendOptions {
  /** 初始引用集合，默认包含 HEAD -> refs/heads/main */
  readonly initialRefs?: Map<string, string>;
  /** 初始 shallow 边界集合，用于测试 shallow 仓库场景 */
  readonly initialShallow?: SHA1[];
}

/**
 * 创建基于内存的仓库后端
 *
 * @param options - 可选初始化参数
 *
 * @example
 * ```ts
 * const backend = createMemoryRepositoryBackend();
 * const repo = createRepository(backend);
 * ```
 */
export function createMemoryRepositoryBackend(
  options: CreateMemoryRepositoryBackendOptions = {},
): RepositoryBackend {
  const refs =
    options.initialRefs ?? new Map<string, string>([[HEAD_REF, `ref: ${HEADS_PREFIX}main`]]);

  // Shallow 状态：内存中持有一个 Set<SHA1>
  const shallowSet = new Set<SHA1>(options.initialShallow ?? []);

  return {
    gitDir: null,
    objects: createMemoryObjectStore(),
    refs: createMemoryRefStore(refs),
    packs: null,

    readShallow(): SHA1[] {
      return Array.from(shallowSet).sort();
    },

    writeShallow(boundaries: SHA1[]): void {
      shallowSet.clear();
      for (const hash of boundaries) {
        shallowSet.add(hash);
      }
    },

    applyShallowUpdate(update: ShallowUpdate): void {
      for (const hash of update.unshallow) {
        shallowSet.delete(hash);
      }
      for (const hash of update.shallow) {
        shallowSet.add(hash);
      }
    },

    isShallowCommit(hash: SHA1): boolean {
      return shallowSet.has(hash);
    },
  };
}
