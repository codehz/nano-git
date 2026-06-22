/**
 * Push 操作编排
 *
 * 负责 repository 层 push 的编排：
 * - pushRemote()：基于 remote 配置的 push（主语义）
 * - push(url)：不依赖 remote 配置的快捷推送
 *
 * 两者最终都通过 transport/push.ts 执行协议层交互。
 * 此层负责 shallow 注入、remote 默认值决策、认证策略合并，
 * 不做协议判断。
 *
 * @example
 * ```ts
 * const ops = createPushRepositoryOperations(backend);
 * const result = await ops.pushRemote("origin");
 * console.log(`Pushed ${result.objectCount} objects`);
 * ```
 */

import { push as transportPush } from "../transport/push.ts";
import { RemoteError } from "./remote-operations.ts";

import type { PushOptions, PushResult } from "../transport/types.ts";
import type { RepositoryBackend } from "./backend/types.ts";
import type {
  PushRemoteOptions,
  PushRemoteResult,
  RepositoryPushOperations,
} from "./push-types.ts";
import type { RemoteConfig } from "./remote-types.ts";

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Push 操作集合
 *
 * @param backend - 仓库后端
 * @returns Push 操作集合
 */
export function createPushRepositoryOperations(
  backend: RepositoryBackend,
): RepositoryPushOperations {
  const { remotes } = backend;

  return {
    async pushRemote(name: string, options?: PushRemoteOptions): Promise<PushRemoteResult> {
      const remote = remotes.get(name);
      if (!remote) {
        throw new RemoteError(`Remote "${name}" not found`);
      }

      return runPushRemote(backend, remote, options);
    },

    async push(url: string, options?: PushOptions): Promise<PushResult> {
      return runPushToUrl(backend, url, options);
    },
  };
}

// ============================================================================
// 内部函数
// ============================================================================

/**
 * 执行基于 remote 配置的 push
 *
 * 负责：
 * 1. 选择 effective pushUrl（options.pushUrl ?? remote.pushUrl ?? remote.url）
 * 2. 读取 shallow state 注入
 * 3. 合并 remote 默认 pushRefSpecs
 * 4. 合并认证策略
 * 5. 调用 transport/push.ts
 */
async function runPushRemote(
  backend: RepositoryBackend,
  remote: RemoteConfig,
  options?: PushRemoteOptions,
): Promise<PushRemoteResult> {
  const effectivePushUrl = options?.pushUrl ?? remote.pushUrl ?? remote.url;
  const currentShallow = backend.shallow.read();

  // 合并 remote 默认 refspec 和调用方显式指定的 refspec
  const effectiveRefSpecs = options?.refSpecs ?? remote.pushRefSpecs;

  const effectiveOptions: PushOptions = {
    ...options,
    refSpecs: effectiveRefSpecs,
    shallowBoundaries:
      options?.shallowBoundaries ?? (currentShallow.length > 0 ? currentShallow : undefined),
  };

  return transportPush(backend.objects, backend.refs, effectivePushUrl, effectiveOptions);
}

/**
 * 执行基于 URL 的 push（不依赖 remote 配置）
 *
 * 只负责 shallow 注入，不做 remote 配置解析。
 */
async function runPushToUrl(
  backend: RepositoryBackend,
  url: string,
  options?: PushOptions,
): Promise<PushResult> {
  const currentShallow = backend.shallow.read();
  const effectiveOptions: PushOptions = {
    ...options,
    shallowBoundaries:
      options?.shallowBoundaries ?? (currentShallow.length > 0 ? currentShallow : undefined),
  };

  return transportPush(backend.objects, backend.refs, url, effectiveOptions);
}
