/**
 * Fetch remote 内部编排
 *
 * 将 fetch 过程拆分为阶段化结果：
 * - fetchedObjects: 本次获取的对象数量
 * - updatedRefs: 已更新的 ref 映射
 * - rejectedRefs: 被拒绝的 ref 列表
 *
 * 与 remote-operations.ts 分离，使 repository 层只负责编排，不裁剪信息。
 * transport 返回值仅在内部消费并转换为 repository 自有类型。
 *
 * @example
 * ```ts
 * const result = await runFetchRemote(backend, remote);
 * console.log(`Fetched ${result.fetchedObjects} objects`);
 * console.log(`Updated ${result.updatedRefs.size} refs`);
 * console.log(`Rejected ${result.rejectedRefs.length} refs`);
 * ```
 */

import { advertiseRemote } from "../transport/advertise.ts";
import { fetchPack } from "../transport/fetch-pack.ts";
import { resolveFetchWants } from "../transport/fetch-plan-finalize.ts";
import { planRefUpdates, validateExactRules } from "../transport/fetch-ref-plan.ts";
import { getLocalRefs } from "../transport/ref-collection.ts";
import { applyRefUpdates } from "../transport/update-refs.ts";

import type { SHA1 } from "../core/types.ts";
import type { RemoteAdvertisement } from "../transport/types.ts";
import type { RepositoryBackend } from "./backend/types.ts";
import type { RemoteConfig, FetchRemoteOptions, FetchRemoteResult } from "./remote-types.ts";

// ============================================================================
// 主入口
// ============================================================================

/**
 * 执行 fetch remote 的内部流程
 *
 * 步骤：广告获取 → ref 规划 → fetch-pack → ref 更新 → shallow 持久化
 * 返回阶段化结果（transfer + refUpdates），不丢失决策上下文。
 *
 * @param backend - 仓库后端
 * @param remote - remote 配置
 * @param options - fetch 选项
 * @param preAdvertised - 可选的预获取广告（避免 bootstrapRemote 等场景重复请求）
 * @returns 阶段化 fetch 结果
 *
 * @example
 * ```ts
 * const result = await runFetchRemote(backend, remote);
 * console.log(`Fetched: ${result.fetchedObjects} objects`);
 * for (const rejected of result.rejectedRefs) {
 *   console.log(`Rejected: ${rejected.localRef} — ${rejected.reason}`);
 * }
 * ```
 */
export async function runFetchRemote(
  backend: RepositoryBackend,
  remote: RemoteConfig,
  options?: FetchRemoteOptions,
  preAdvertised?: RemoteAdvertisement,
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

  // 3. 获取本地 refs 并规划更新（纯映射层，不涉及对象库）
  const localRefs = getLocalRefs(refs);
  const plan = planRefUpdates(adv.refs, localRefs, remote.fetchRules);

  // 4. 传输计划推导：结合对象库状态补正 wants
  const transferPlan = resolveFetchWants(plan, objects, { depth: options?.depth });

  // 5. 需要传输时执行 fetch-pack
  let packResult: { objectCount: number; shallow?: SHA1[]; unshallow?: SHA1[] } | undefined;

  if (transferPlan.needsPackNegotiation) {
    // 6. 构造 have 候选
    const haveTips = selectHaveTipsForRemote(localRefs, plan.updates);
    const currentShallow = backend.shallow.read();

    // 7. 执行 fetch-pack
    packResult = await fetchPack(objects, {
      url: remote.url,
      wants: transferPlan.wants,
      haves: haveTips.length > 0 ? haveTips : undefined,
      depth: options?.depth,
      shallow: currentShallow.length > 0 ? currentShallow : undefined,
      token: options?.token,
      headers: options?.headers,
      maxCandidates: options?.maxCandidates,
    });

    // 8. shallow 持久化
    if (packResult.shallow || packResult.unshallow) {
      backend.shallow.applyUpdate({
        shallow: packResult.shallow ?? [],
        unshallow: packResult.unshallow ?? [],
      });
    }
  }

  // 9. 应用 ref 更新（无论是否有传输，只要 plan.updates 有内容就执行）
  //    典型场景：本地对象已存在但 tracking ref 未创建时，
  //    无需传输对象但仍需更新 ref。
  let transportUpdatedRefs = new Map<string, SHA1>();
  let transportRejectedRefs: Array<{ localRef: string; reason: string }> = [];

  if (plan.updates.length > 0) {
    const refUpdateResult = applyRefUpdates(objects, refs, plan.updates);
    transportUpdatedRefs = refUpdateResult.updatedRefs;
    transportRejectedRefs = refUpdateResult.rejectedRefs;
  }

  return convertToFetchRemoteResult(
    packResult,
    transportUpdatedRefs,
    transportRejectedRefs,
    adv.defaultBranch,
  );
}

// ============================================================================
// 内部辅助
// ============================================================================

/**
 * 为 remote fetch 选择 have 遍历起点
 *
 * 优先级：
 * 1. wants 对应的 remote-tracking ref 旧值
 * 2. 同一远端命名空间下的其他 remote-tracking refs
 * 3. HEAD
 * 4. 本地 refs/heads/*（兜底）
 *
 * @param localRefs - 本地全部 ref 映射
 * @param updates - ref 更新计划项
 * @returns have 遍历起点哈希列表
 */
export function selectHaveTipsForRemote(
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

// ============================================================================
// 类型转换
// ============================================================================

/**
 * 将原始数据转换为 repository 自有类型
 *
 * 接受最小必要参数，不依赖 transport 层类型的形状。
 * transport 返回值仅在调用方提取字段后传入。
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
