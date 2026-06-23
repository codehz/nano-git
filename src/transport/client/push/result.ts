/**
 * 响应解析（receive-pack）
 *
 * 解析 `git-receive-pack` 返回的 report-status 响应。
 *
 * report-status 格式：
 *   <status-line>\n
 *   ...
 *   0000
 *
 * 每条 status-line：
 *   ok <ref-name>
 *   ng <ref-name> <error-msg>
 *
 * @see https://git-scm.com/docs/pack-protocol#_report_status
 */

import { GitError } from "../../../core/errors.ts";
import { parsePktLines } from "../../shared/pkt-line.ts";

import type { PushRefUpdate } from "../../shared/types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * Receive-pack 结果解析错误
 *
 * 当 report-status 数据格式不符合 Git 协议规范时抛出。
 */
export class ReceivePackResultError extends GitError {
  constructor(message: string) {
    super(`receive-pack result error: ${message}`);
    this.name = "ReceivePackResultError";
  }
}

// ============================================================================
// 常量
// ============================================================================

/** report-status 中的 "ok" 前缀 */
const OK_PREFIX = "ok ";
/** report-status 中的 "ng" 前缀 */
const NG_PREFIX = "ng ";

// ============================================================================
// 解析函数
// ============================================================================

/**
 * 从 receive-pack 响应中解析 report-status
 *
 * 输入数据应为已经过 side-band 解复用后的纯 pkt-line report-status 数据。
 * 如果响应是 side-band 编码的，需要先调用 `extractPackfile`/`extractProgress`
 * 再使用本函数解析 report-status 部分（在 side-band 中 report-status 位于
 * channel 1 的 packfile 数据末尾的 pkt-line 中）。
 *
 * @param data - 来自服务端的 report-status 响应体（pkt-line 编码）
 * @returns 解析后的引用更新状态列表，每个条目标明成功/失败及错误消息
 *
 * @example
 * ```ts
 * const result = parseReceivePackResult(responseBody);
 * for (const update of result) {
 *   console.log(`${update.refName}: ${update.success ? "OK" : "FAIL: " + update.error}`);
 * }
 * ```
 */
export function parseReceivePackResult(data: Buffer): PushRefUpdate[] {
  const pktLines = parsePktLines(data);
  const updates: PushRefUpdate[] = [];
  let seenUnpack = false;

  for (const line of pktLines) {
    if (line.type !== "data") {
      // flush/delimiter/response-end 终止解析
      continue;
    }

    const payload = line.payload.toString("utf-8").trimEnd();

    if (payload.length === 0) {
      continue;
    }

    // report-status 协议要求第一条状态行必须是 "unpack <status>"
    if (!seenUnpack) {
      if (payload.startsWith("unpack ")) {
        seenUnpack = true;
        const unpackResult = payload.slice("unpack ".length);
        if (unpackResult !== "ok") {
          throw new ReceivePackResultError(`Server failed to unpack packfile: ${unpackResult}`);
        }
        continue;
      }
      throw new ReceivePackResultError(
        `Missing unpack status line: first status line is "${payload}", expected "unpack <result>"`,
      );
    }

    if (payload.startsWith(OK_PREFIX)) {
      const refName = payload.slice(OK_PREFIX.length);
      updates.push({
        refName,
        oldHash: null,
        newHash: null,
        success: true,
        forced: false,
      });
    } else if (payload.startsWith(NG_PREFIX)) {
      const rest = payload.slice(NG_PREFIX.length);
      const spaceIndex = rest.indexOf(" ");
      if (spaceIndex === -1) {
        throw new ReceivePackResultError(
          `Invalid ng status line: "${payload}" (missing error message)`,
        );
      }
      const refName = rest.substring(0, spaceIndex);
      const errorMsg = rest.substring(spaceIndex + 1);
      updates.push({
        refName,
        oldHash: null,
        newHash: null,
        success: false,
        error: errorMsg,
        forced: false,
      });
    } else if (payload.startsWith("unpack ")) {
      // 重复 unpack 行也视为非法
      throw new ReceivePackResultError(`Unexpected duplicate unpack status line: "${payload}"`);
    } else {
      throw new ReceivePackResultError(
        `Unexpected status line: "${payload}" (expected "ok " or "ng ")`,
      );
    }
  }

  return updates;
}
