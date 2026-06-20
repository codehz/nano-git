/**
 * pkt-line 帧编解码
 *
 * Git 协议的基本传输单元。每条帧以 4 字符十六进制长度前缀开头，
 * 后跟对应长度的负载数据。
 *
 * 帧类型：
 * - 数据帧：长度前缀在 0004–FFF4 之间（含 4 字节前缀自身）
 * - 0000：flush-pkt，表示结束
 * - 0001：delimiter-pkt（协议 v2）
 * - 0002：response-end-pkt（协议 v2）
 *
 * @example
 * ```ts
 * const data = encodePktLine("hello");
 * console.log(data.toString("hex")); // => "000968656c6c6f"
 * ```
 *
 * @see https://github.com/git/git/blob/master/Documentation/technical/pkt-line.txt
 */

import { GitError } from "../core/errors.ts";

// ============================================================================
// 类型
// ============================================================================

/** pkt-line 解码结果 */
export interface PktLineData {
  type: "data";
  /** 负载数据（不含 4 字节长度前缀） */
  payload: Buffer;
}

export interface PktLineFlush {
  type: "flush";
}

export interface PktLineDelimiter {
  type: "delimiter";
}

export interface PktLineResponseEnd {
  type: "response-end";
}

/** 解析后的 pkt-line 类型 */
export type PktLine = PktLineData | PktLineFlush | PktLineDelimiter | PktLineResponseEnd;

// ============================================================================
// 错误类型
// ============================================================================

/**
 * pkt-line 协议错误
 *
 * 当 pkt-line 数据格式不符合 Git 协议规范时抛出。
 */
export class PktLineError extends GitError {
  constructor(message: string) {
    super(`pkt-line error: ${message}`);
    this.name = "PktLineError";
  }
}

// ============================================================================
// 编码函数
// ============================================================================

/** pkt-line 特殊帧的十六进制编码 */
const FLUSH_PKT_HEX = "0000";
const DELIMITER_PKT_HEX = "0001";
const RESPONSE_END_PKT_HEX = "0002";

/** pkt-line 长度前缀的字节数 */
const LENGTH_PREFIX_BYTES = 4;

/** pkt-line 数据帧的最大总长度（含 4 字节前缀） */
const MAX_PACKET_SIZE = 65524; // 0xFFF4

/** pkt-line 数据帧的最大负载长度 */
const MAX_PAYLOAD_SIZE = MAX_PACKET_SIZE - LENGTH_PREFIX_BYTES; // 65520

/**
 * 编码 pkt-line 数据帧
 *
 * 将 payload 编码为 pkt-line 格式："XXXX<payload>"
 * 其中 XXXX 是含 4 字节前缀的总长度（十六进制）。
 *
 * @param payload - 负载数据（字符串或 Buffer）
 * @returns pkt-line 编码后的 Buffer
 *
 * @example
 * ```ts
 * const buf = encodePktLine("hello");
 * console.log(buf.toString("utf-8")); // => "0009hello"
 * ```
 */
export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;

  if (data.length > MAX_PAYLOAD_SIZE) {
    throw new PktLineError(`Payload too large: ${data.length} bytes (max ${MAX_PAYLOAD_SIZE})`);
  }

  const length = data.length + LENGTH_PREFIX_BYTES;
  const prefix = length.toString(16).padStart(4, "0").toUpperCase();
  return Buffer.concat([Buffer.from(prefix, "utf-8"), data]);
}

/**
 * 生成 flush-pkt
 *
 * @returns Buffer("0000")
 *
 * @example
 * ```ts
 * const buf = encodeFlushPkt();
 * console.log(buf.toString("utf-8")); // => "0000"
 * ```
 */
export function encodeFlushPkt(): Buffer {
  return Buffer.from(FLUSH_PKT_HEX, "utf-8");
}

/**
 * 生成 delimiter-pkt（协议 v2）
 *
 * @returns Buffer("0001")
 */
export function encodeDelimiterPkt(): Buffer {
  return Buffer.from(DELIMITER_PKT_HEX, "utf-8");
}

/**
 * 生成 response-end-pkt（协议 v2）
 *
 * @returns Buffer("0002")
 */
export function encodeResponseEndPkt(): Buffer {
  return Buffer.from(RESPONSE_END_PKT_HEX, "utf-8");
}

// ============================================================================
// 解码函数
// ============================================================================

/**
 * 解析 pkt-line 编码的完整数据流
 *
 * 将包含一个或多个 pkt-line 帧的 Buffer 解析为 PktLine 数组。
 *
 * @param data - 完整的 pkt-line 编码数据
 * @returns 解析后的 PktLine 列表
 *
 * @example
 * ```ts
 * const lines = parsePktLines(Buffer.from("0009hello0000", "utf-8"));
 * // lines[0] = { type: "data", payload: Buffer("hello") }
 * // lines[1] = { type: "flush" }
 * ```
 */
export function parsePktLines(data: Buffer): PktLine[] {
  const result: PktLine[] = [];
  let offset = 0;

  while (offset < data.length) {
    // 检查是否有足够的字节存放 4 字符长度前缀
    if (offset + LENGTH_PREFIX_BYTES > data.length) {
      throw new PktLineError(
        `Truncated pkt-line: need ${LENGTH_PREFIX_BYTES} bytes for length prefix, got ${data.length - offset}`,
      );
    }

    const hex = data.subarray(offset, offset + LENGTH_PREFIX_BYTES).toString("utf-8");

    // 校验十六进制格式
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      throw new PktLineError(`Invalid pkt-line length: "${hex}"`);
    }

    const length = parseInt(hex, 16);
    offset += LENGTH_PREFIX_BYTES;

    // 特殊帧
    if (length === 0) {
      // 0000 - flush
      result.push({ type: "flush" });
    } else if (length === 1) {
      // 0001 - delimiter
      result.push({ type: "delimiter" });
    } else if (length === 2) {
      // 0002 - response-end
      result.push({ type: "response-end" });
    } else {
      // 数据帧：长度至少为 0004（空 payload）
      if (length < LENGTH_PREFIX_BYTES) {
        throw new PktLineError(
          `Invalid pkt-line length: ${length} (minimum data length is ${LENGTH_PREFIX_BYTES})`,
        );
      }

      if (length > MAX_PACKET_SIZE) {
        throw new PktLineError(`Invalid pkt-line length: ${length} (max ${MAX_PACKET_SIZE})`);
      }

      const payloadLength = length - LENGTH_PREFIX_BYTES;

      // 检查缓冲区是否足够
      if (offset + payloadLength > data.length) {
        throw new PktLineError(
          `Truncated pkt-line: expected ${payloadLength} bytes of payload, got ${data.length - offset}`,
        );
      }

      const payload = data.subarray(offset, offset + payloadLength);
      offset += payloadLength;
      result.push({ type: "data", payload });
    }
  }

  return result;
}
