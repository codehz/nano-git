/**
 * Remote 操作编排
 *
 * 维护 remote 配置，编排 advertiseRemote → planRefUpdates → fetchPack → applyRefUpdates，
 * 并对 shallow store 做统一持久化。
 *
 * @example
 * ```ts
 * const ops = createRemoteRepositoryOperations(backend);
 * ops.addRemote({ name: "origin", url: "https://...", fetchRules: [...] });
 * const result = await ops.fetchRemote("origin");
 * ```
 */

import { GitError } from "../core/errors.ts";
import { sha1 } from "../core/types.ts";
import { advertiseRemote } from "../transport/advertise.ts";
import { runFetchRemote } from "./fetch-remote.ts";

import type { RepositoryBackend } from "./backend/types.ts";
import type {
  RemoteConfig,
  FetchRemoteOptions,
  FetchRemoteResult,
  BootstrapRemoteOptions,
  BootstrapRemoteResult,
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
// Remote 操作接口
// ============================================================================

/**
 * Remote 操作集合
 */
export interface RepositoryRemoteOperations {
  /** 添加 remote 配置 */
  addRemote(config: RemoteConfig): void;
  /** 获取 remote 配置 */
  getRemote(name: string): RemoteConfig | null;
  /** 列出所有 remote 名称 */
  listRemotes(): string[];
  /**
   * 从 remote 拉取对象和更新 remote-tracking refs
   *
   * 只更新 remote-tracking refs（如 refs/remotes/origin/*），
   * 不创建本地分支，不修改 HEAD。
   */
  fetchRemote(name: string, options?: FetchRemoteOptions): Promise<FetchRemoteResult>;
  /**
   * 从 remote 拉取并创建本地分支和 HEAD
   *
   * 先执行 fetchRemote()，然后根据远端默认分支（或显式指定）：
   * - 创建 refs/heads/<branch>
   * - 设置 HEAD -> refs/heads/<branch>
   *
   * 这是唯一会创建本地分支和设置 HEAD 的 API。
   */
  bootstrapRemote(name: string, options?: BootstrapRemoteOptions): Promise<BootstrapRemoteResult>;
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
      const rejectedRef = fetchResult.refUpdates.rejectedRefs.find(
        (r) => r.localRef === trackingRef,
      );
      if (rejectedRef) {
        throw new RemoteError(
          `Default branch "${adv.defaultBranch}" tracking ref "${trackingRef}" was rejected: ` +
            `${rejectedRef.reason}`,
        );
      }

      // 优先从 fetch 结果取，若未变化则回退读取现有 tracking ref
      const branchHash =
        fetchResult.refUpdates.updatedRefs.get(trackingRef) ??
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
  };
}

// ============================================================================
// 内部函数
// ============================================================================

/**
 * 将远端默认分支通过 fetchRules 映射为本地 tracking ref
 *
 * 注意：source 可能以 + 开头（表示 force），需要先去除。
 */
function mapDefaultBranchToTrackingRef(
  defaultBranch: string,
  fetchRules: RemoteConfig["fetchRules"],
): string | undefined {
  for (const rule of fetchRules) {
    const cleanSource = rule.source.startsWith("+") ? rule.source.slice(1) : rule.source;

    if (!cleanSource.includes("*")) {
      if (cleanSource === defaultBranch) {
        return rule.target;
      }
    } else {
      const srcPattern = cleanSource.replace("*", "");
      if (defaultBranch.startsWith(srcPattern)) {
        const suffix = defaultBranch.slice(srcPattern.length);
        return rule.target.replace("*", suffix);
      }
    }
  }
  return undefined;
}
