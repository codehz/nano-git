/**
 * 高层 push 编排
 *
 * 编排完整的 Smart HTTP push 流程：
 * 1. 获取远程 receive-pack ref 广告
 * 2. 按 refspec 确定要推送的本地引用与远程目标
 * 3. 收集需要发送的对象（推送 ref 可达且远程缺失的对象）
 * 4. 构建 packfile
 * 5. 构造 receive-pack 请求并发送
 * 6. 解析 report-status 响应
 *
 * @example
 * ```ts
 * import { initRepository } from "./repository/index.ts";
 * import { push } from "./transport/push.ts";
 *
 * const repo = initRepository("/tmp/my-repo");
 * const result = await push(repo.objects, repo.refs, "https://github.com/user/repo");
 * console.log(`Pushed ${result.objectCount} objects`);
 * ```
 */

import { createPackWriter } from "../odb/pack/pack-writer.ts";
import { PushError } from "./push-error.ts";
import { mergePushBoundaries, computeObjectsToSend } from "./push-pack-plan.ts";
import { checkFastForward } from "./push-policy.ts";
import { resolveDefaultRefSpec, determinePushRefs } from "./push-ref-plan.ts";
import { processPushReport } from "./push-report.ts";
import { buildReceivePackRequest } from "./receive-pack-request.ts";
import { ReceivePackResultError } from "./receive-pack-result.ts";
import { getLocalRefs, remoteRefsToMap } from "./ref-collection.ts";
import { parseRefSpec } from "./refspec.ts";
import { createSmartHttpClient } from "./smart-http.ts";
import { extractCapabilities, PUSH_CAPABILITIES } from "./transport-capabilities.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectStore } from "../odb/types.ts";
import type { RefStore } from "../refs/types.ts";
import type { ParsedRefSpec } from "./refspec.ts";
import type { PushOptions, PushResult, PushRefUpdate } from "./types.ts";

// ============================================================================
// Re-export 子模块类型（保持向后兼容）
// ============================================================================

export { PushError } from "./push-error.ts";
export { checkFastForward } from "./push-policy.ts";
export { determinePushRefs } from "./push-ref-plan.ts";
export type { PushRefItem } from "./push-ref-plan.ts";

// ============================================================================
// 常量
// ============================================================================

/** 零哈希（表示新建引用或删除引用） */
const ZERO_HASH = "0000000000000000000000000000000000000000";

// ============================================================================
// Push 编排
// ============================================================================

/**
 * 执行 push 操作
 *
 * 将本地对象推送到远程 Git 仓库。
 *
 * @param store - 本地对象存储
 * @param refs - 本地引用存储
 * @param url - 远程仓库 URL（如 "https://github.com/user/repo"）
 * @param options - 可选配置
 * @returns push 操作结果
 *
 * @example
 * ```ts
 * const result = await push(repo.objects, repo.refs, "https://github.com/user/repo");
 * console.log(`Pushed ${result.objectCount} objects`);
 * ```
 */
export async function push(
  store: ObjectStore,
  refs: RefStore,
  url: string,
  options?: PushOptions,
): Promise<PushResult> {
  const client =
    options?.transport ??
    createSmartHttpClient(url, {
      token: options?.token,
      headers: options?.headers,
    });

  // 1. 获取远程 receive-pack ref 广告
  const adv = await client.getReceivePackRefs();

  // 2. 解析 refspec（未提供时按 HEAD 指向的分支动态生成）
  const refSpecStr = options?.refSpecs ?? [resolveDefaultRefSpec(refs)];
  const parsedSpecs = refSpecStr.map(parseRefSpec);

  // 对 force 选项的处理：如果 PushOptions.force 为 true，将所有 force 标志设置为 true
  const effectiveSpecs: ParsedRefSpec[] = options?.force
    ? parsedSpecs.map((s) => ({ ...s, force: true }))
    : parsedSpecs;

  // 3. 获取 shallow 边界集合（用于更精确的缺失对象判断）
  const shallowSet: Set<SHA1> | undefined = options?.shallowBoundaries
    ? new Set(options.shallowBoundaries)
    : undefined;

  // 4. 获取本地 refs 和远程 refs
  const localRefs = getLocalRefs(refs);
  const remoteRefs = remoteRefsToMap(adv.refs);

  // 5. 确定要推送的引用
  const pushRefs = determinePushRefs(localRefs, remoteRefs, effectiveSpecs);

  if (pushRefs.length === 0) {
    return {
      refUpdates: [],
      objectCount: 0,
      progress: [],
    };
  }

  // 推送边界：shallow 边界 + 各 ref 远端当前 tip（本地可无对象，服务端仍持有）
  // 注意：此合并边界仅用于对象收集（collectReachable），不可用于 fast-forward 预检。
  const pushBoundaries = mergePushBoundaries(shallowSet, pushRefs);

  // 6. non-fast-forward 预检
  //    未设 force 的更新如果不是 fast-forward 则立即报错。
  //    此处的边界只传 shallowSet（不含所有 ref 的统一远端 tip 合并集），
  //    逐 ref 的远端 tip 由 checkFastForward 内部按 item 独立加入边界，
  //    避免 A ref 的缺失 parent 被 B ref 的远端 tip 错误放行。
  checkFastForward(store, pushRefs, shallowSet);

  // 7. 计算需要发送的对象
  const objectsToSend = computeObjectsToSend(store, pushRefs, remoteRefs, pushBoundaries);

  // 8. 构建 packfile（objectsToSend 已在 local reachable 遍历中校验存在）
  const packWriter = createPackWriter();
  for (const hash of objectsToSend) {
    const obj = store.read(hash);
    packWriter.addObject(obj);
  }
  const packfile = packWriter.build();

  // 9. 确定可用能力 & 前置校验
  const caps = extractCapabilities(adv.capabilities, PUSH_CAPABILITIES);

  if (!caps.includes("report-status")) {
    throw new PushError(
      "Remote server does not advertise 'report-status' capability. " +
        "This client requires report-status to reliably determine push results. " +
        "Please use a Git server that supports report-status.",
    );
  }

  const hasDeleteCommand = pushRefs.some((r) => r.localHash === null);
  if (hasDeleteCommand && !caps.includes("delete-refs")) {
    throw new PushError(
      "Remote server does not advertise 'delete-refs' capability, " +
        "but the push includes a delete ref operation.",
    );
  }

  // 10. 构造 receive-pack 命令 & 请求
  //     删除操作时 newHash 用零哈希表示
  const commands = pushRefs.map((r) => ({
    oldHash: r.remoteHash ?? (ZERO_HASH as SHA1),
    newHash: r.localHash ?? (ZERO_HASH as SHA1),
    refName: r.remoteRef,
  }));

  const body = buildReceivePackRequest(commands, packfile, caps);

  // 11. 发送请求
  let progress: string[];
  let refUpdates: PushRefUpdate[];
  try {
    const result = await client.postReceivePack(body);
    progress = result.progress;
    refUpdates = result.refUpdates;
  } catch (err: unknown) {
    if (err instanceof ReceivePackResultError) {
      throw new PushError(`Remote server rejected the push: ${err.message}`);
    }
    throw err;
  }

  // 12. 校验并富化服务端报告
  const report = processPushReport(commands, refUpdates, pushRefs, progress);

  return {
    refUpdates: report.refUpdates,
    objectCount: packWriter.objectCount,
    progress: report.progress,
  };
}
