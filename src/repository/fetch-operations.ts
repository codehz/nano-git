/**
 * Fetch 操作编排
 *
 * repository 层只保留显式 URL 的 fetch 入口。
 */

import { runFetchToUrl } from "./fetch-url.ts";

import type { RepositoryBackend } from "./backend/types.ts";
import type {
  RepositoryFetchOptions,
  RepositoryFetchOperations,
  RepositoryFetchResult,
} from "./fetch-types.ts";

/**
 * 创建仓库 fetch 操作集合
 *
 * @param backend - 仓库后端
 * @returns fetch 操作集合
 */
export function createFetchRepositoryOperations(
  backend: RepositoryBackend,
): RepositoryFetchOperations {
  return {
    async fetch(url: string, options?: RepositoryFetchOptions): Promise<RepositoryFetchResult> {
      return runFetchToUrl(backend, url, options);
    },
  };
}
