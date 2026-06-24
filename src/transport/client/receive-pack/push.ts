/**
 * 高层 push 编排
 *
 * 编排完整的 Smart HTTP push 流程：
 * 1. 按 refspec 确定要推送的本地引用与远程目标
 * 2. 收集需要发送的对象
 * 3. 构建 packfile
 * 4. 构造 receive-pack 请求并发送
 * 5. 解析 report-status 响应
 *
 * push() 不再自行创建传输层或获取 advertisement ——
 * 这两种依赖由调用方通过 ReceivePackTransport + RefAdvertisement 显式传入。
 *
 * @example
 * ```ts
 * import { push } from "./transport/push.ts";
 *
 * const transport = createReceivePackHttpClient("https://github.com/user/repo");
 * const adv = await transport.advertise();
 * const result = await push(store, refs, transport, adv, { refSpecs: [...] });
 * console.log(`Pushed ${result.objectCount} objects`);
 * ```
 */

import { createPackWriter } from "../../../pack/pack-writer.ts";
import { getLocalRefs, remoteRefsToMap } from "../../protocol/ref-collection.ts";
import { PushError } from "./push-error.ts";
import { mergePushBoundaries, computeObjectsToSend } from "./push-pack-plan.ts";
import { checkFastForward } from "./push-policy.ts";
import { determinePushRefs } from "./push-ref-plan.ts";
import { processPushReport } from "./push-report.ts";
import {
  buildPushCommands,
  buildPushRequestBody,
  resolvePushParsedSpecs,
  validatePushCapabilities,
} from "./push-request-plan.ts";
import { decodeReceivePackResponse } from "./response.ts";
import { ReceivePackResultError } from "./result.ts";

import type { SHA1 } from "../../../core/types.ts";
import type { RefStore } from "../../../core/types/refs.ts";
import type { ObjectDatabase } from "../../../odb/types.ts";
import type {
  ReceivePackTransport,
  RefAdvertisement,
  PushOptions,
  PushResult,
} from "../../protocol/types.ts";

// ============================================================================
// Re-export 子模块类型
// ============================================================================

export { PushError } from "./push-error.ts";
export { checkFastForward } from "./push-policy.ts";
export { determinePushRefs } from "./push-ref-plan.ts";
export type { PushRefItem } from "./push-ref-plan.ts";

// ============================================================================
// Push 编排
// ============================================================================

/**
 * 执行 push 操作
 *
 * 将本地对象推送到远程 Git 仓库。调用方需自行创建 ReceivePackTransport
 * 并获取 advertisement。
 *
 * @param store - 本地对象存储
 * @param refs - 本地引用存储
 * @param transport - receive-pack 传输接口
 * @param advertisement - 服务端 receive-pack 广告
 * @param options - 可选配置（refSpecs、force、shallowBoundaries）
 * @returns push 操作结果
 *
 * @example
 * ```ts
 * const transport = createReceivePackHttpClient("https://github.com/user/repo");
 * const adv = await transport.advertise();
 * const result = await push(store, refs, transport, adv, { refSpecs: [...] });
 * console.log(`Pushed ${result.objectCount} objects`);
 * ```
 */
export async function push(
  store: ObjectDatabase,
  refs: RefStore,
  transport: ReceivePackTransport,
  advertisement: RefAdvertisement,
  options?: PushOptions,
): Promise<PushResult> {
  // 1. 解析 refspec
  const effectiveSpecs = resolvePushParsedSpecs(refs, options);

  // 2. 获取 shallow 边界集合
  const shallowSet: Set<SHA1> | undefined = options?.shallowBoundaries
    ? new Set(options.shallowBoundaries)
    : undefined;

  // 3. 获取本地 refs 和远程 refs
  const localRefs = getLocalRefs(refs);
  const remoteRefs = remoteRefsToMap(advertisement.refs);

  // 4. 确定要推送的引用
  const pushRefs = determinePushRefs(localRefs, remoteRefs, effectiveSpecs);

  if (pushRefs.length === 0) {
    return {
      refUpdates: [],
      objectCount: 0,
      progress: [],
    };
  }

  // 推送边界：shallow 边界 + 各 ref 远端当前 tip
  const pushBoundaries = mergePushBoundaries(shallowSet, pushRefs);

  // 5. non-fast-forward 预检
  checkFastForward(store, pushRefs, shallowSet);

  // 6. 计算需要发送的对象
  const objectsToSend = computeObjectsToSend(store, pushRefs, remoteRefs, pushBoundaries);

  // 7. 构建 packfile
  const packWriter = createPackWriter();
  for (const hash of objectsToSend) {
    const raw = store.read(hash);
    packWriter.addRaw(raw);
  }
  const packfile = packWriter.build();

  // 8. 能力校验、命令与请求 body
  const caps = validatePushCapabilities(advertisement, pushRefs);
  const commands = buildPushCommands(pushRefs);
  const body = buildPushRequestBody(commands, packfile, caps);

  // 9. 发送请求并解码响应
  let progress: string[];
  let refUpdates: import("../../protocol/types.ts").PushRefUpdate[];
  try {
    const raw = await transport.request(body);
    const decoded = decodeReceivePackResponse(raw);
    progress = decoded.progress;
    refUpdates = decoded.refUpdates;
  } catch (err: unknown) {
    if (err instanceof ReceivePackResultError) {
      throw new PushError(`Remote server rejected the push: ${err.message}`);
    }
    throw err;
  }

  // 10. 校验并富化服务端报告
  const report = processPushReport(commands, refUpdates, pushRefs, progress);

  return {
    refUpdates: report.refUpdates,
    objectCount: packWriter.objectCount,
    progress: report.progress,
  };
}
