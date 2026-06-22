/**
 * Push 操作编排
 *
 * repository 层只保留显式 URL 的 push 入口。
 *
 * @example
 * ```ts
 * const ops = createPushRepositoryOperations(backend);
 * const result = await ops.push("https://example.com/repo.git", {
 *   refSpecs: ["refs/heads/main:refs/heads/main"],
 * });
 * console.log(`Pushed ${result.pushedRefs.length} refs`);
 * ```
 */

import { GitError } from "../core/errors.ts";
import { runPushToUrl } from "./push-url.ts";

import type { RepositoryBackend } from "./backend/types.ts";
import type {
  RepositoryPushOptions,
  RepositoryPushOperations,
  RepositoryPushResult,
} from "./push-types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * Push 操作错误
 */
export class PushError extends GitError {
  constructor(message: string) {
    super(`Push error: ${message}`);
    this.name = "PushError";
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建仓库 push 操作集合
 *
 * @param backend - 仓库后端
 * @returns push 操作集合
 */
export function createPushRepositoryOperations(
  backend: RepositoryBackend,
): RepositoryPushOperations {
  return {
    async push(url: string, options?: RepositoryPushOptions): Promise<RepositoryPushResult> {
      return runPushToUrl(backend, url, options);
    },
  };
}
