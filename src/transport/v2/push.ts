/**
 * v2 push 命令
 *
 * Git Wire 协议 v2 的 push 命令实现。
 *
 * v2 push 请求格式：
 * ```
 * command=push\n                    (pkt-line)
 * agent=nano-git/0.1\n             (pkt-line, capabilities)
 * 0001                               (delimiter)
 * push-option=<value>\n             (pkt-line, args)
 * 0000                               (flush)
 * <old> <new> <ref>\0<caps>\n       (v1 风格命令，原始数据)
 * <old> <new> <ref>\n
 * 0000
 * <packfile>                         (原始包数据)
 * ```
 *
 * v2 push 响应使用 side-band 多路复用（同 v1），
 * report-status 在 channel 1，进度在 channel 2。
 *
 * @see https://git-scm.com/docs/protocol-v2#_push
 */

import { GitError } from "../../core/errors.ts";
import { parsePktLines } from "../shared/pkt-line.ts";
import { parseReceivePackResult } from "../v1/receive-pack-result.ts";

import type { SHA1 } from "../../core/types.ts";
import type { V2GitServiceTransport } from "./types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * v2 push 错误
 */
export class V2PushError extends GitError {
  constructor(message: string) {
    super(`v2 push error: ${message}`);
    this.name = "V2PushError";
  }
}

// ============================================================================
// 类型
// ============================================================================

/**
 * v2 push 命令条目
 *
 * 对应 v1 风格的单条引用更新命令。
 */
export interface V2PushCommand {
  /** 远端当前哈希（新建引用时为 000...0） */
  readonly oldHash: SHA1;
  /** 要推送的本地哈希（删除引用时为 000...0） */
  readonly newHash: SHA1;
  /** 引用完整名称 */
  readonly refName: string;
}

/**
 * v2 push 结果条目
 */
export interface V2PushRefUpdate {
  readonly refName: string;
  readonly oldHash: SHA1 | null;
  readonly newHash: SHA1 | null;
  readonly success: boolean;
  readonly error?: string;
  readonly forced: boolean;
}

/**
 * v2 push 操作结果
 */
export interface V2PushResult {
  readonly refUpdates: V2PushRefUpdate[];
  readonly progress: string[];
}

// ============================================================================
// v2 push 主函数
// ============================================================================

/**
 * 执行 v2 push 操作
 *
 * 构建并发送 push 命令请求，返回解析后的 push 结果。
 *
 * @param transport - v2 传输接口
 * @param commands - 引用更新命令列表
 * @param packfile - 包含推送对象的 packfile
 * @param capabilities - 命令携带的能力（如 report-status, side-band-64k, ofs-delta）
 * @param pushOptions - 可选的 push-option 列表
 * @returns push 操作结果
 *
 * @example
 * ```ts
 * const result = await v2Push(transport, commands, packfile, caps);
 * console.log(result.refUpdates); // [{ refName, success, error }, ...]
 * ```
 */
export async function v2Push(
  transport: V2GitServiceTransport,
  commands: V2PushCommand[],
  packfile: Buffer,
  capabilities?: string[],
  pushOptions?: string[],
): Promise<V2PushResult> {
  if (commands.length === 0) {
    throw new V2PushError("No commands specified for push");
  }

  // 构建 push-option args
  const args: string[] = [];
  if (pushOptions) {
    for (const opt of pushOptions) {
      args.push(`push-option ${opt}`);
    }
  }

  // 构建 v1 风格的命令行 + packfile 作为附加 body
  const bodyLines: Buffer[] = [];
  let firstCapWritten = false;

  for (const cmd of commands) {
    if (!firstCapWritten && capabilities && capabilities.length > 0) {
      // 首行带 capabilities
      bodyLines.push(
        Buffer.from(
          `${cmd.oldHash} ${cmd.newHash} ${cmd.refName}\0${capabilities.join(" ")}\n`,
          "utf-8",
        ),
      );
      firstCapWritten = true;
    } else {
      bodyLines.push(Buffer.from(`${cmd.oldHash} ${cmd.newHash} ${cmd.refName}\n`, "utf-8"));
    }
  }
  bodyLines.push(Buffer.from("0000", "utf-8"));
  bodyLines.push(packfile);

  const fullBody = Buffer.concat(bodyLines);

  const raw = await transport.command("push", args, [], fullBody);

  return parseV2PushResponse(raw);
}

// ============================================================================
// 响应解析
// ============================================================================

/**
 * 解析 v2 push 响应
 *
 * v2 push 响应复用 side-band 多路复用（同 v1）。
 * - channel 0x01: report-status 数据
 * - channel 0x02: 进度消息
 * - channel 0x03: 致命错误
 *
 * @param data - 原始响应数据
 * @returns 解析后的 push 结果
 *
 * @example
 * ```ts
 * const result = parseV2PushResponse(raw);
 * console.log(result.refUpdates);
 * ```
 */
export function parseV2PushResponse(data: Buffer): V2PushResult {
  const pktLines = parsePktLines(data);
  let progress: string[] = [];
  let reportStatusData: Buffer | null = null;

  for (const line of pktLines) {
    if (line.type !== "data") continue;

    const payload = line.payload;
    if (payload.length < 2) continue;

    const channel = payload[0]!;
    const frameData = payload.subarray(1).toString("utf-8");

    if (channel === 0x01) {
      // report-status 行：累加到已有的数据后
      const existing = reportStatusData ?? Buffer.alloc(0);
      reportStatusData = Buffer.concat([
        existing,
        Buffer.from(frameData.trimEnd() + "\n", "utf-8"),
      ]);
    } else if (channel === 0x02) {
      progress.push(frameData.trimEnd());
    } else if (channel === 0x03) {
      throw new V2PushError(`Server reported error: ${frameData.trimEnd()}`);
    }
  }

  // 如果没有 side-band，尝试直接解析为 report-status
  if (!reportStatusData) {
    reportStatusData = data;
  }

  // 解析 report-status
  const reportUpdates = parseReceivePackResult(reportStatusData);

  const refUpdates: V2PushRefUpdate[] = reportUpdates.map((u) => ({
    refName: u.refName,
    oldHash: u.oldHash,
    newHash: u.newHash,
    success: u.success,
    error: u.error,
    forced: u.forced ?? false,
  }));

  return { refUpdates, progress };
}

// ============================================================================
// 辅助函数：v1 push 结果转 v2 格式
// ============================================================================

/**
 * 将 v1 PushResult 转换为 v2 V2PushResult
 */
export function v1PushResultToV2(
  refUpdates: Array<{
    refName: string;
    oldHash: SHA1 | null;
    newHash: SHA1 | null;
    success: boolean;
    error?: string;
    forced: boolean;
  }>,
  progress: string[],
): V2PushResult {
  return {
    refUpdates: refUpdates.map((u) => ({
      refName: u.refName,
      oldHash: u.oldHash,
      newHash: u.newHash,
      success: u.success,
      error: u.error,
      forced: u.forced ?? false,
    })),
    progress,
  };
}
