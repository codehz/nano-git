/**
 * Push 响应报告校验
 *
 * 处理"服务端回复是否完整可信"的问题：
 * - receive-pack 返回结果的完整性校验
 * - 命令和 refUpdates 的对应关系校验
 * - enrichedUpdates 构建
 *
 * @example
 * ```ts
 * import { processPushReport } from "./push-report.ts";
 * import { PushError } from "./push-error.ts";
 *
 * try {
 *   const result = processPushReport(commands, refUpdates, pushRefs, progress);
 *   return result;
 * } catch (err) {
 *   if (err instanceof PushError && err.refUpdates) {
 *     // 部分成功场景
 *   }
 * }
 * ```
 */

import { PushError } from "./push-error.ts";

import type { PushRefUpdate } from "../../shared/types.ts";
import type { PushRefItem } from "./push-ref-plan.ts";
import type { ReceivePackCommand } from "./request.ts";

/**
 * 校验并富化服务端返回的 report-status 结果
 *
 * 执行以下校验：
 * 1. 空 refUpdates 检测（协议异常）
 * 2. 状态行数量一致性校验
 * 3. ref 名称集合完全匹配校验
 * 4. 构建富化 refUpdates（补充 oldHash/newHash/forced）
 * 5. 检查被拒绝的更新
 *
 * @param commands - 发送给服务端的 receive-pack 命令列表
 * @param refUpdates - 服务端解析后的 ref 更新结果
 * @param pushRefs - 推送引用项列表（用于关联命令与元信息）
 * @param progress - 服务端返回的进度消息
 * @returns 富化后的完整 push 结果
 * @throws PushError 当校验失败或存在被拒绝的更新时
 */
export function processPushReport(
  commands: ReceivePackCommand[],
  refUpdates: PushRefUpdate[],
  pushRefs: PushRefItem[],
  progress: string[],
): { refUpdates: PushRefUpdate[]; progress: string[] } {
  // 防御性检查：发送了命令但收到空 refUpdates 属于协议异常
  if (commands.length > 0 && refUpdates.length === 0) {
    throw new PushError(
      "Server returned no status updates for the push commands. " +
        "This may indicate a protocol compatibility issue or a server-side parsing error.",
    );
  }

  // 校验服务端返回的状态行是否覆盖了所有已发送命令
  if (commands.length !== refUpdates.length) {
    const receivedRefNames = new Set(refUpdates.map((u) => u.refName));
    const missingRefs = commands.filter((c) => !receivedRefNames.has(c.refName));
    throw new PushError(
      `Server returned incomplete status: expected ${commands.length} status line(s) ` +
        `but got ${refUpdates.length}. Missing status for: ${missingRefs.map((r) => r.refName).join(", ")}`,
    );
  }

  // 校验服务端返回的 ref 名称集合与发送命令完全一致
  const commandRefNames = new Set(commands.map((c) => c.refName));
  const updateRefNames = new Set(refUpdates.map((u) => u.refName));
  const unexpectedRefs = [...updateRefNames].filter((n) => !commandRefNames.has(n));
  const missingRefs = [...commandRefNames].filter((n) => !updateRefNames.has(n));
  if (unexpectedRefs.length > 0 || missingRefs.length > 0) {
    const parts: string[] = [];
    if (unexpectedRefs.length > 0) {
      parts.push(`unexpected ref(s): ${unexpectedRefs.join(", ")}`);
    }
    if (missingRefs.length > 0) {
      parts.push(`missing ref(s): ${missingRefs.join(", ")}`);
    }
    throw new PushError(`Server returned mismatched ref status: ${parts.join("; ")}`);
  }

  // 将服务端返回的 report-status 与我们的推送引用关联，补充 oldHash/newHash/forced 信息
  const pushRefMap = new Map<string, PushRefItem>();
  for (const item of pushRefs) {
    pushRefMap.set(item.remoteRef, item);
  }

  const enrichedUpdates: PushRefUpdate[] = refUpdates.map((u) => {
    const matched = pushRefMap.get(u.refName);
    return {
      refName: u.refName,
      oldHash: matched?.remoteHash ?? null,
      newHash: matched?.localHash ?? null,
      success: u.success,
      error: u.error,
      forced: matched?.force ?? false,
    };
  });

  // 检查是否有被服务端拒绝的更新
  const rejectedUpdates = enrichedUpdates.filter((u) => !u.success);
  if (rejectedUpdates.length > 0) {
    const details = rejectedUpdates
      .map((u) => `${u.refName}: ${u.error ?? "unknown error"}`)
      .join("; ");
    throw new PushError(`Remote server rejected the push: ${details}`, {
      refUpdates: enrichedUpdates,
      progress,
    });
  }

  return { refUpdates: enrichedUpdates, progress };
}
