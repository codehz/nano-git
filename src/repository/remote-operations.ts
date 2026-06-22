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
import { sha1 } from "../core/types.ts";
import { advertiseRemote } from "../transport/advertise.ts";
import { push as transportPush } from "../transport/push.ts";
import { runFetchRemote } from "./fetch-remote.ts";
import { mapDefaultBranchToTrackingRef } from "./remote-mapping.ts";

import type { PushOptions } from "../transport/types.ts";
import type { RepositoryBackend } from "./backend/types.ts";
import type {
  RemoteConfig,
  FetchRemoteOptions,
  FetchRemoteResult,
  BootstrapRemoteOptions,
  BootstrapRemoteResult,
  PushRemoteOptions,
  PushRemoteResult,
  PushRefUpdateResult,
  RepositoryRemoteOperations,
} from "./remote-types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * Remote 操作错误
 */
export class RemoteError extends GitError {
  constructor(message: string) {
    super(`Remote error: ${message}`);
    this.name = "RemoteError";
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Remote 操作集合
 *
 * @param backend - 仓库后端
 * @returns Remote 操作集合
 */
export function createRemoteRepositoryOperations(
  backend: RepositoryBackend,
): RepositoryRemoteOperations {
  const { refs, remotes } = backend;

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

    async fetchRemote(name: string, options?: FetchRemoteOptions): Promise<FetchRemoteResult> {
      const remote = remotes.get(name);
      if (!remote) {
        throw new RemoteError(`Remote "${name}" not found`);
      }

      return runFetchRemote(backend, remote, options);
    },

    async bootstrapRemote(
      name: string,
      options?: BootstrapRemoteOptions,
    ): Promise<BootstrapRemoteResult> {
      const remote = remotes.get(name);
      if (!remote) {
        throw new RemoteError(`Remote "${name}" not found`);
      }

      // 1. 获取远端广告以确定默认分支
      const adv = await advertiseRemote(remote.url, {
        token: options?.token,
        headers: options?.headers,
      });

      if (!adv.defaultBranch) {
        throw new RemoteError(
          `Remote "${name}" at ${remote.url} does not advertise a default branch. ` +
            `Cannot bootstrap without a known default branch.`,
        );
      }

      // 2. 执行 fetch（复用已获取的广告，避免重复请求）
      const fetchResult = await runFetchRemote(backend, remote, options, adv);

      // 3. 确定本地分支名
      const localBranch = options?.branch ?? adv.defaultBranch.replace("refs/heads/", "");

      // 4. 校验远端默认分支是否在本次更新结果中
      const branchRef = localBranch.startsWith("refs/heads/")
        ? localBranch
        : `refs/heads/${localBranch}`;
      const trackingRef = mapDefaultBranchToTrackingRef(adv.defaultBranch, remote.fetchRules);

      if (!trackingRef) {
        throw new RemoteError(
          `Cannot map remote default branch "${adv.defaultBranch}" to a local tracking ref. ` +
            `Check fetchRules configuration for remote "${name}".`,
        );
      }

      // 检查默认分支的 tracking ref 是否被拒绝
      const rejectedRef = fetchResult.rejectedRefs.find((r) => r.localRef === trackingRef);
      if (rejectedRef) {
        throw new RemoteError(
          `Default branch "${adv.defaultBranch}" tracking ref "${trackingRef}" was rejected: ` +
            `${rejectedRef.reason}`,
        );
      }

      // 优先从 fetch 结果取，若未变化则回退读取现有 tracking ref
      const branchHash =
        fetchResult.updatedRefs.get(trackingRef) ??
        (() => {
          const existing = refs.read(trackingRef);
          if (existing && /^[0-9a-f]{40}$/.test(existing)) {
            return sha1(existing);
          }
          return undefined;
        })();

      if (!branchHash) {
        throw new RemoteError(
          `Default branch "${adv.defaultBranch}" was not fetched. ` +
            `Its tracking ref "${trackingRef}" is missing from both fetch result and local refs.`,
        );
      }

      // 5. 创建本地分支并设置 HEAD
      refs.write(branchRef, branchHash);
      refs.write("HEAD", `ref: ${branchRef}`);

      return {
        ...fetchResult,
        localBranch: branchRef,
      };
    },

    async pushRemote(name: string, options?: PushRemoteOptions): Promise<PushRemoteResult> {
      const remote = remotes.get(name);
      if (!remote) {
        throw new RemoteError(`Remote "${name}" not found`);
      }

      return runPushRemote(backend, remote, options);
    },

    async push(url: string, options?: PushOptions): Promise<PushRemoteResult> {
      return runPushToUrl(backend, url, options);
    },
  };
}

// ============================================================================
// 内部函数
// ============================================================================

/**
 * 执行基于 remote 配置的 push
 */
async function runPushRemote(
  backend: RepositoryBackend,
  remote: RemoteConfig,
  options?: PushRemoteOptions,
): Promise<PushRemoteResult> {
  const effectivePushUrl = options?.pushUrl ?? remote.pushUrl ?? remote.url;
  const currentShallow = backend.shallow.read();

  const effectiveRefSpecs = options?.refSpecs ?? remote.pushRefSpecs;

  const effectiveOptions: PushOptions = {
    ...options,
    refSpecs: effectiveRefSpecs,
    shallowBoundaries:
      options?.shallowBoundaries ?? (currentShallow.length > 0 ? currentShallow : undefined),
  };

  const transportResult = await transportPush(
    backend.objects,
    backend.refs,
    effectivePushUrl,
    effectiveOptions,
  );

  return convertPushResult(transportResult);
}

/**
 * 执行基于 URL 的 push（不依赖 remote 配置）
 */
async function runPushToUrl(
  backend: RepositoryBackend,
  url: string,
  options?: PushOptions,
): Promise<PushRemoteResult> {
  const currentShallow = backend.shallow.read();
  const effectiveOptions: PushOptions = {
    ...options,
    shallowBoundaries:
      options?.shallowBoundaries ?? (currentShallow.length > 0 ? currentShallow : undefined),
  };

  const transportResult = await transportPush(backend.objects, backend.refs, url, effectiveOptions);

  return convertPushResult(transportResult);
}

/**
 * 将 transport PushResult 转换为 repository PushRemoteResult
 */
function convertPushResult(result: import("../transport/types.ts").PushResult): PushRemoteResult {
  const pushedRefs: PushRefUpdateResult[] = result.refUpdates.map((u) => ({
    refName: u.refName,
    oldHash: u.oldHash,
    newHash: u.newHash,
    success: u.success,
    error: u.error,
    forced: u.forced,
  }));

  return {
    pushedRefs,
    objectCount: result.objectCount,
    progress: result.progress,
  };
}
