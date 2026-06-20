/**
 * Smart HTTP Fetch 传输层
 *
 * 提供 Git Smart HTTP 协议的客户端实现，包含：
 * - pkt-line 帧编解码
 * - 引用广告解析
 * - side-band 多路解复用
 * - 请求生成与 HTTP 传输
 * - 高层 fetch 编排
 */

// P1: 核心类型
export type { RemoteRef, RefAdvertisement, FetchOptions, FetchResult } from "./types.ts";

// P1: pkt-line 编解码
export {
  encodePktLine,
  encodeFlushPkt,
  encodeDelimiterPkt,
  encodeResponseEndPkt,
  parsePktLines,
  PktLineError,
} from "./pkt-line.ts";
export type {
  PktLine,
  PktLineData,
  PktLineFlush,
  PktLineDelimiter,
  PktLineResponseEnd,
} from "./pkt-line.ts";

// P2: ref 广告解析 & side-band 解复用
export { parseRefAdvertisement, RefAdvertisementError } from "./ref-advertisement.ts";
export { extractPackfile, extractProgress, SideBandError } from "./side-band.ts";
