/**
 * Remote 操作编排
 *
 * 统一维护 remote 配置，编排 fetch 和 push 的完整流程：
 * - 配置管理：addRemote / getRemote / listRemotes
 * - Fetch：advertiseRemote → planRefUpdates → fetchPack → applyRefUpdates
 * - Push：advertiseRemote → determinePushRefs → checkFastForward → push
 * - Bootstrap：fetch + 创建本地分支 + 设置 HEAD
 *
 * repository 层定义自有结果类型，transport 返回值仅在内部消费并转换。
 *
 * @example
 * ```ts
 * const ops = createRemoteRepositoryOperations(backend);
 * ops.addRemote({ name: "origin", url: "https://...", fetchRules: [...] });
 * const result = await ops.fetchRemote("origin");
 * console.log(`Fetched ${result.fetchedObjects} objects`);
 * ```
 */

import { GitError } from "../core/errors.ts";
import { runPushRemote, runPushToUrl } from "./push-remote.ts";

import type { RepositoryBackend } from "./backend/types.ts";
import type {
  RemoteConfig,
  PushRemoteOptions,
  PushRemoteResult,
  RepositoryRemoteOperations,
} from "./remote-types.ts";

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
 * 创建 Remote 操作集合
 *
 * 仅保留 push 和 remote 配置管理。fetch 相关操作已由 ImportSession API 替代。
 *
 * @param backend - 仓库后端
 * @returns Remote 操作集合
 */
export function createRemoteRepositoryOperations(
  backend: RepositoryBackend,
): RepositoryRemoteOperations {
  const { remotes } = backend;

  return {
    addRemote(config: RemoteConfig): void {
      remotes.set(config);
    },

    getRemote(name: string): RemoteConfig | null {
      return remotes.get(name);
    },

    listRemotes(): string[] {
      return remotes.list().map((remote) => remote.name);
    },

    async pushRemote(name: string, options?: PushRemoteOptions): Promise<PushRemoteResult> {
      const remote = remotes.get(name);
      if (!remote) {
        throw new PushError(`Remote "${name}" not found`);
      }

      return runPushRemote(backend, remote, options);
    },

    async push(url: string, options?: PushRemoteOptions): Promise<PushRemoteResult> {
      return runPushToUrl(backend, url, options);
    },
  };
}
