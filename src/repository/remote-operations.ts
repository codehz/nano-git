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
import { sha1, type SHA1 } from "../core/types.ts";
import { advertiseRemote } from "../transport/advertise.ts";
import { fetchPack } from "../transport/fetch-pack.ts";
import { getLocalRefs, planRefUpdates, validateExactRules } from "../transport/ref-plan.ts";
import { applyRefUpdates } from "../transport/update-refs.ts";

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
  const remotes = new Map<string, RemoteConfig>();
  const { refs } = backend;

  return {
    addRemote(config: RemoteConfig): void {
      remotes.set(config.name, config);
    },

    getRemote(name: string): RemoteConfig | null {
      return remotes.get(name) ?? null;
    },

    listRemotes(): string[] {
      return [...remotes.keys()];
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
  };
}

// ============================================================================
// 内部函数
// ============================================================================

/**
 * 执行 fetch remote 的内部流程
 *
 * 步骤：广告获取 → ref 规划 → fetch-pack → ref 更新 → shallow 持久化
 *
 * @param preAdvertised - 可选的预获取广告（避免 bootstrapRemote 等场景重复请求）
 */
async function runFetchRemote(
  backend: RepositoryBackend,
  remote: RemoteConfig,
  options?: FetchRemoteOptions,
  preAdvertised?: import("../transport/types.ts").RemoteAdvertisement,
): Promise<FetchRemoteResult> {
  const { objects, refs } = backend;

  // 1. 获取远端广告（若已由调用方预获取则复用）
  const adv =
    preAdvertised ??
    (await advertiseRemote(remote.url, {
      token: options?.token,
      headers: options?.headers,
    }));

  // 2. 校验非通配符规则
  validateExactRules(adv.refs, remote.fetchRules);

  // 3. 获取本地 refs 并规划更新
  const localRefs = getLocalRefs(refs);
  const plan = planRefUpdates(adv.refs, localRefs, remote.fetchRules, objects);

  // 4. 处理纯 shallow deepen 场景：即使 wants 为空也需执行协商
  const hasShallowOptions = options?.depth !== undefined;
  const needsDeepen = hasShallowOptions && plan.wants.length === 0;

  // 即使 wants 为空，如果有 pending 的 ref 更新（如上次被拒绝的 force 更新），
  // 仍需执行 fetch-pack 获取对象后应用 ref 更新
  const hasPendingUpdates = plan.updates.some((u) => u.force || u.currentLocalHash !== undefined);

  if (plan.wants.length === 0 && !needsDeepen && !hasPendingUpdates) {
    return {
      updatedRefs: new Map(),
      objectCount: 0,
      defaultBranch: adv.defaultBranch,
    };
  }

  // 5. 构造 have 候选
  const haveTips = selectHaveTipsForRemote(localRefs, plan.updates);
  const currentShallow = backend.shallow.read();

  // 6. 执行 fetch-pack
  const packResult = await fetchPack(objects, {
    url: remote.url,
    wants: needsDeepen ? plan.matchedRemoteRefs.map((r) => r.hash) : plan.wants,
    haves: haveTips.length > 0 ? haveTips : undefined,
    depth: options?.depth,
    shallow: currentShallow.length > 0 ? currentShallow : undefined,
    token: options?.token,
    headers: options?.headers,
    maxCandidates: options?.maxCandidates,
  });

  // 7. 应用 ref 更新
  const refUpdateResult = applyRefUpdates(objects, refs, plan.updates);

  // 8. shallow 持久化
  if (packResult.shallow || packResult.unshallow) {
    backend.shallow.applyUpdate({
      shallow: packResult.shallow ?? [],
      unshallow: packResult.unshallow ?? [],
    });
  }

  return {
    updatedRefs: refUpdateResult.updatedRefs,
    objectCount: packResult.objectCount,
    shallow: packResult.shallow,
    unshallow: packResult.unshallow,
    defaultBranch: adv.defaultBranch,
  };
}

/**
 * 为 remote fetch 选择 have 遍历起点
 *
 * 优先级：
 * 1. wants 对应的 remote-tracking ref 旧值
 * 2. 同一远端命名空间下的其他 remote-tracking refs
 * 3. HEAD
 * 4. 本地 refs/heads/*（兜底）
 */
function selectHaveTipsForRemote(
  localRefs: Map<string, SHA1>,
  updates: Array<{ localRef: string; currentLocalHash?: SHA1 }>,
): SHA1[] {
  const tips: SHA1[] = [];
  const seen = new Set<SHA1>();

  // 第一优先：wants 对应的 remote-tracking ref 旧值
  for (const u of updates) {
    if (u.currentLocalHash && !seen.has(u.currentLocalHash)) {
      seen.add(u.currentLocalHash);
      tips.push(u.currentLocalHash);
    }
  }

  // 推导远端命名空间前缀
  const remotePrefixes = new Set<string>();
  for (const u of updates) {
    const m = u.localRef.match(/^(refs\/remotes\/[^/]+\/)/);
    if (m) {
      remotePrefixes.add(m[1]!);
    }
  }

  // 第二优先：同一远端命名空间下的其他 remote-tracking refs
  for (const [refName, hash] of localRefs) {
    if (seen.has(hash)) continue;
    if (refName.startsWith("refs/remotes/")) {
      if (remotePrefixes.size === 0 || [...remotePrefixes].some((p) => refName.startsWith(p))) {
        seen.add(hash);
        tips.push(hash);
      }
    }
  }

  // 第三优先：HEAD
  const headHash = localRefs.get("HEAD");
  if (headHash && !seen.has(headHash)) {
    seen.add(headHash);
    tips.push(headHash);
  }

  // 第四优先：本地 heads（兜底）
  for (const [refName, hash] of localRefs) {
    if (seen.has(hash)) continue;
    if (refName.startsWith("refs/heads/")) {
      seen.add(hash);
      tips.push(hash);
    }
  }

  return tips;
}

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
