/**
 * upload-pack 服务端类型定义与常量
 */

import { GitError } from "../../../errors.ts";

import type { GitErrorOptions } from "../../../errors.ts";

// ============================================================================
// 常量
// ============================================================================

/** 服务端 agent 字符串 */
export const SERVER_AGENT = "nano-git/0.1";

/** 服务端当前支持的对象格式 */
export const SERVER_OBJECT_FORMAT = "sha1";

/** side-band 通道编号 */
export const CHANNEL_PACKFILE = 0x01;
export const CHANNEL_PROGRESS = 0x02;
export const CHANNEL_FATAL = 0x03;

/** pkt-line 单帧最大负载字节数 */
export const MAX_PKT_PAYLOAD = 65520;

// ============================================================================
// 错误类型
// ============================================================================

/**
 * upload-pack 服务错误
 *
 * 当服务端处理请求时遇到可预见的错误情况抛出。
 *
 * @example
 * ```ts
 * throw new UploadPackServiceError("no commits selected", { cause: err });
 * ```
 */
export class UploadPackServiceError extends GitError {
  constructor(message: string, options?: GitErrorOptions) {
    super(`upload-pack: ${message}`, options);
    this.name = "UploadPackServiceError";
  }
}
