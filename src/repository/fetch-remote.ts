/**
 * Fetch remote 内部编排
 *
 * 顺序固定为：
 * 1. 创建 upload-pack client
 * 2. 拉一次 advertisement
 * 3. planRefUpdates（直接产出 wants）
 * 4. 若 wants 非空则 fetchPack()
 * 5. applyRefUpdates()
 *
 * 一次 fetchRemote() 最多一次 GET /info/refs?service=git-upload-pack。
 *
 * @example
 * ```ts
 * const result = await runFetchRemote(backend, remote);
 * console.log(`Fetched ${result.fetchedObjects} objects`);
 * console.log(`Updated ${result.updatedRefs.size} refs`);
 * ```
 */

import { fetchPack } from "../transport/fetch-pack.ts";
import { planRefUpdates, validateExactRules } from "../transport/fetch-ref-plan.ts";
import { getLocalRefs } from "../transport/ref-collection.ts";
import { createUploadPackHttpClient } from "../transport/smart-http.ts";
import { applyRefUpdates } from "../transport/update-refs.ts";

import type { SHA1 } from "../core/types.ts";
import type { UploadPackTransport, RefAdvertisement, MatchedRefItem } from "../transport/types.ts";
import type { RepositoryBackend } from "./backend/types.ts";
import type { RemoteConfig, FetchRemoteOptions, FetchRemoteResult } from "./remote-types.ts";

// ============================================================================
// 主入口
// ============================================================================

/**
 * 执行 fetch remote 的内部流程
 *
 * 步骤：
 * 1. 创建 upload-pack client（若提供了 transportFactory 则使用之，否则用 HTTP）
 * 2. 拉一次 advertisement（若 preAdvertised 提供则复用）
 * 3. ref 规划并推导 wants（planRefUpdates）
 * 4. wants 非空则执行 fetch-pack
 * 5. 应用 ref 更新
 * 6. shallow 持久化
 *
 * @param backend - 仓库后端
 * @param remote - remote 配置
 * @param options - fetch 选项
 * @param preAdvertised - 可选的预获取广告（避免 bootstrapRemote 等场景重复请求）
 * @param transportFactory - 可选的 transport 工厂（用于测试注入）
 * @returns fetch 结果（repository 自有语义）
 *
 * @example
 * ```ts
 * const result = await runFetchRemote(backend, remote);
 * console.log(`Fetched: ${result.fetchedObjects} objects`);
 * ```
 */
export async function runFetchRemote(
  backend: RepositoryBackend,
  remote: RemoteConfig,
  options?: FetchRemoteOptions,
  preAdvertised?: RefAdvertisement,
  transportFactory?: (url: string, options?: FetchRemoteOptions) => UploadPackTransport,
): Promise<FetchRemoteResult> {
  const { objects, refs } = backend;

  // 1. 创建 transport（可注入替代实现用于测试）
  const createTransport =
    transportFactory ??
    ((url: string) =>
      createUploadPackHttpClient(url, {
        token: options?.token,
        headers: options?.headers,
      }));
  const transport = createTransport(remote.url, options);

  // 2. 获取远端广告（若已由调用方预获取则复用）
  const adv: RefAdvertisement = preAdvertised ?? (await transport.getRefAdvertisement());

  // 3. 校验非通配符规则
  validateExactRules(adv.refs, remote.fetchRules);

  // 4. 获取本地 refs 并规划更新（直接产出 FetchPlan，含 wants）
  const localRefs = getLocalRefs(refs);
  const plan = planRefUpdates(adv.refs, localRefs, objects, remote.fetchRules, options?.depth);

  // 5. 需要传输时执行 fetch-pack
  let packResult: { objectCount: number; shallow?: SHA1[]; unshallow?: SHA1[] } | undefined;

  if (plan.needsPackNegotiation) {
    const haveTips = selectHaveTipsForRemote(localRefs, plan.matchedItems);
    const currentShallow = backend.shallow.read();

    packResult = await fetchPack(objects, transport, adv, {
      wants: plan.wants,
      haves: haveTips.length > 0 ? haveTips : undefined,
      depth: options?.depth,
      shallow: currentShallow.length > 0 ? currentShallow : undefined,
      maxCandidates: options?.maxCandidates,
    });

    // 6. shallow 持久化
    if (packResult.shallow || packResult.unshallow) {
      backend.shallow.applyUpdate({
        shallow: packResult.shallow ?? [],
        unshallow: packResult.unshallow ?? [],
      });
    }
  }

  // 7. 应用 ref 更新
  let transportUpdatedRefs = new Map<string, SHA1>();
  let transportRejectedRefs: Array<{ localRef: string; reason: string }> = [];

  if (plan.refUpdates.length > 0) {
    const refUpdateResult = applyRefUpdates(objects, refs, plan.refUpdates);
    transportUpdatedRefs = refUpdateResult.updatedRefs;
    transportRejectedRefs = refUpdateResult.rejectedRefs;
  }

  return convertToFetchRemoteResult(
    packResult,
    transportUpdatedRefs,
    transportRejectedRefs,
    extractDefaultBranch(adv),
  );
}

// ============================================================================
// 内部辅助
// ============================================================================

/**
 * 为 remote fetch 选择 have 遍历起点
 *
 * 使用 matchedItems（而非仅 refUpdates），以便在“hashEqual 但对象缺失”的补对象场景
 * 也能提供最优的 have 起点（no-op 场景不会走到这里）。
 *
 * 优先级：
 * 1. wants 对应的 remote-tracking ref 旧值
 * 2. 同一远端命名空间下的其他 remote-tracking refs
 * 3. HEAD
 * 4. 本地 refs/heads/*（兜底）
 */
export function selectHaveTipsForRemote(
  localRefs: Map<string, SHA1>,
  matchedItems: MatchedRefItem[],
): SHA1[] {
  const tips: SHA1[] = [];
  const seen = new Set<SHA1>();

  for (const u of matchedItems) {
    if (u.currentLocalHash && !seen.has(u.currentLocalHash)) {
      seen.add(u.currentLocalHash);
      tips.push(u.currentLocalHash);
    }
  }

  const remotePrefixes = new Set<string>();
  for (const u of matchedItems) {
    const m = u.localRef.match(/^(refs\/remotes\/[^/]+\/)/);
    if (m) {
      remotePrefixes.add(m[1]!);
    }
  }

  for (const [refName, hash] of localRefs) {
    if (seen.has(hash)) continue;
    if (refName.startsWith("refs/remotes/")) {
      if (remotePrefixes.size === 0 || [...remotePrefixes].some((p) => refName.startsWith(p))) {
        seen.add(hash);
        tips.push(hash);
      }
    }
  }

  const headHash = localRefs.get("HEAD");
  if (headHash && !seen.has(headHash)) {
    seen.add(headHash);
    tips.push(headHash);
  }

  for (const [refName, hash] of localRefs) {
    if (seen.has(hash)) continue;
    if (refName.startsWith("refs/heads/")) {
      seen.add(hash);
      tips.push(hash);
    }
  }

  return tips;
}

// ============================================================================
// 内部辅助
// ============================================================================

/**
 * 从 RefAdvertisement 中提取 defaultBranch
 */
function extractDefaultBranch(adv: RefAdvertisement): string | undefined {
  let defaultBranch: string | undefined;
  const symref = adv.capabilities["symref"];
  if (typeof symref === "string") {
    const colonIndex = symref.indexOf(":");
    if (colonIndex !== -1) {
      const headName = symref.substring(0, colonIndex);
      if (headName === "HEAD") {
        defaultBranch = symref.substring(colonIndex + 1);
      }
    }
  }
  if (defaultBranch === undefined) {
    const heads = adv.refs.filter((r) => r.name.startsWith("refs/heads/"));
    if (heads.length === 1) {
      defaultBranch = heads[0]!.name;
    }
  }
  return defaultBranch;
}

/**
 * 将原始数据转换为 repository 自有类型
 */
function convertToFetchRemoteResult(
  packResult: { objectCount: number } | undefined,
  transportUpdatedRefs: Map<string, SHA1>,
  transportRejectedRefs: Array<{ localRef: string; reason: string }>,
  defaultBranch?: string,
): FetchRemoteResult {
  return {
    fetchedObjects: packResult?.objectCount ?? 0,
    updatedRefs: transportUpdatedRefs,
    rejectedRefs: transportRejectedRefs.map((r) => ({
      localRef: r.localRef,
      reason: r.reason,
    })),
    defaultBranch,
  };
}
