/**
 * 基于内存的仓库后端
 *
 * 适用于测试和临时操作场景。
 */

import { createMemoryObjectStore } from "../../odb/memory.ts";
import { createMemoryRefStore } from "../../refs/memory.ts";
import { HEAD_REF, HEADS_PREFIX } from "../../refs/types.ts";
import { createMemoryShallowStore } from "../../shallow/memory.ts";

import type { SHA1 } from "../../core/types.ts";
import type { RepositoryBackend } from "./types.ts";

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

  return {
    gitDir: null,
    objects: createMemoryObjectStore(),
    refs: createMemoryRefStore(refs),
    shallow: createMemoryShallowStore(options.initialShallow),
    packs: null,
  };
}
