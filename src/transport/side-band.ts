/**
 * side-band 多路解复用
 *
 * Git 协议使用 side-band 在单一连接上多路传输数据。
 * side-band-64k 将数据分割为 pkt-line 帧，每帧第一个字节为 channel 编号。
 *
 * Channel 约定：
 * - 0x01: packfile 数据（需拼接为完整 packfile）
 * - 0x02: 进度消息（可用于显示传输进度）
 * - 0x03: 致命错误（传输过程中出错）
 *
 * @see https://git-scm.com/docs/pack-protocol#_side_channel
 */

import { GitError } from "../core/errors.ts";
import { parsePktLines } from "./pkt-line.ts";

// ============================================================================
// 常量
// ============================================================================

/** side-band channel 编号 */
const CHANNEL_PACKFILE = 0x01;
const CHANNEL_PROGRESS = 0x02;
const CHANNEL_FATAL = 0x03;

// ============================================================================
// 错误类型
// ============================================================================

/**
 * side-band 协议错误
 *
 * 当 side-band 数据格式不符合 Git 协议规范时抛出。
 */
export class SideBandError extends GitError {
  constructor(message: string) {
    super(`side-band error: ${message}`);
    this.name = "SideBandError";
  }
}

// ============================================================================
// 解复用函数
// ============================================================================

/**
 * 从 side-band 编码的响应数据中提取 packfile
 *
 * 将 channel 1 的所有帧拼接为完整的 packfile buffer。
 *
 * @param data - 包含 side-band pkt-line 帧的完整响应数据
 * @returns 拼接后的 packfile buffer
 *
 * @example
 * ```ts
 * const packfile = extractPackfile(responseData);
 * const reader = createPackReader(packfile);
 * ```
 */
export function extractPackfile(data: Buffer): Buffer {
  const chunks: Buffer[] = [];

  processSideBand(data, {
    onPackfile(chunk) {
      chunks.push(chunk);
    },
    onProgress() {
      // 进度消息默认忽略
    },
    onFatal(msg) {
      throw new SideBandError(`Server reported fatal error: ${msg}`);
    },
  });

  if (chunks.length === 0) {
    throw new SideBandError("No packfile data found in side-band stream");
  }

  return Buffer.concat(chunks);
}

/**
 * 从 side-band 编码的响应数据中提取进度消息
 *
 * 收集 channel 2 的所有消息。
 *
 * @param data - 包含 side-band pkt-line 帧的完整响应数据
 * @returns 进度消息列表
 *
 * @example
 * ```ts
 * const messages = extractProgress(responseData);
 * console.log(messages);
 * // [ "Receiving objects:  10% (1/10)", ... ]
 * ```
 */
export function extractProgress(data: Buffer): string[] {
  const messages: string[] = [];

  processSideBand(data, {
    onPackfile() {
      // packfile 数据默认忽略
    },
    onProgress(msg) {
      messages.push(msg);
    },
    onFatal(msg) {
      throw new SideBandError(`Server reported fatal error: ${msg}`);
    },
  });

  return messages;
}

// ============================================================================
// 内部类型与实现
// ============================================================================

/** side-band 处理回调 */
interface SideBandHandlers {
  onPackfile(chunk: Buffer): void;
  onProgress(msg: string): void;
  onFatal(msg: string): void;
}

/**
 * 处理 side-band 数据流
 *
 * 遍历所有 pkt-line 帧，根据 channel 编号分发到对应回调。
 */
function processSideBand(data: Buffer, handlers: SideBandHandlers): void {
  const pktLines = parsePktLines(data);

  for (const line of pktLines) {
    if (line.type !== "data") {
      // flush/delimiter/response-end 正常终止
      continue;
    }

    const payload = line.payload;

    if (payload.length === 0) {
      continue;
    }

    const channel = payload[0]!;

    if (payload.length < 2) {
      // 只有 channel 编号没有数据是合法的（空包）
      continue;
    }

    const content = payload.subarray(1);

    switch (channel) {
      case CHANNEL_PACKFILE:
        handlers.onPackfile(content);
        break;
      case CHANNEL_PROGRESS:
        handlers.onProgress(content.toString("utf-8"));
        break;
      case CHANNEL_FATAL:
        handlers.onFatal(content.toString("utf-8"));
        break;
      default:
        // 未知 channel，忽略
        break;
    }
  }
}
