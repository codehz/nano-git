/**
 * v2 upload-pack 服务端类型定义与常量
 */

// ============================================================================
// 常量
// ============================================================================

/** 服务端 agent 字符串 */
export const SERVER_AGENT = "nano-git/0.1";

/** side-band 通道编号 */
export const CHANNEL_PACKFILE = 0x01;
export const CHANNEL_FATAL = 0x03;

/** pkt-line 单帧最大负载字节数 */
export const MAX_PKT_PAYLOAD = 65520;

// ============================================================================
// 错误类型
// ============================================================================

/**
 * 服务端错误
 *
 * 当服务端处理请求时遇到可预见的错误情况抛出。
 */
export class V2ServeError extends Error {
  constructor(message: string) {
    super(`v2 serve: ${message}`);
    this.name = "V2ServeError";
  }
}
