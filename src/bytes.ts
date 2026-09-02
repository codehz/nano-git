/**
 * 内部字节工具（Web 标准 Uint8Array）
 *
 * 替代 Node.js Buffer 专有 API，供 src/ 内部使用。
 */

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

const HEX_CHARS = "0123456789abcdef";

/**
 * UTF-8 字符串编码为字节
 */
export function utf8ToBytes(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

/**
 * 字节解码为 UTF-8 字符串
 */
export function bytesToUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

/**
 * ASCII 字符串编码为字节（Git 协议 ASCII 子集）
 */
export function asciiToBytes(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

/**
 * 字节解码为 ASCII 字符串
 */
export function bytesToAscii(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

/**
 * 十六进制字符串解码为字节
 *
 * @throws 如果 hex 长度为奇数或包含非法字符
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`invalid hex string length: ${hex.length}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const hi = HEX_CHARS.indexOf(hex.charAt(i * 2).toLowerCase());
    const lo = HEX_CHARS.indexOf(hex.charAt(i * 2 + 1).toLowerCase());
    if (hi < 0 || lo < 0) {
      throw new Error(`invalid hex character at position ${i * 2}`);
    }
    bytes[i] = (hi << 4) | lo;
  }
  return bytes;
}

/**
 * 字节编码为十六进制字符串（小写）
 */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    hex += HEX_CHARS.charAt(byte >> 4);
    hex += HEX_CHARS.charAt(byte & 0x0f);
  }
  return hex;
}

/**
 * 字节编码为 Base64 字符串
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * 分配指定长度的零填充字节数组
 */
export function allocBytes(size: number, fill = 0): Uint8Array {
  const bytes = new Uint8Array(size);
  if (fill !== 0) {
    bytes.fill(fill);
  }
  return bytes;
}

/**
 * 连接多个字节数组
 */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * 比较两个字节数组是否相等
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * 将 src 复制到 dest 的指定偏移
 */
export function copyBytes(
  dest: Uint8Array,
  destOffset: number,
  src: Uint8Array,
  srcOffset = 0,
  length = src.length - srcOffset,
): void {
  dest.set(src.subarray(srcOffset, srcOffset + length), destOffset);
}

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * 读取大端 16 位无符号整数
 */
export function readU16BE(data: Uint8Array, offset: number): number {
  return viewOf(data).getUint16(offset, false);
}

/**
 * 写入大端 16 位无符号整数
 */
export function writeU16BE(data: Uint8Array, offset: number, value: number): void {
  viewOf(data).setUint16(offset, value, false);
}

/**
 * 读取 8 位无符号整数
 */
export function readU8(data: Uint8Array, offset: number): number {
  return data[offset]!;
}

/**
 * 写入 8 位无符号整数
 */
export function writeU8(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value;
}

/**
 * 读取大端 32 位无符号整数
 */
export function readU32BE(data: Uint8Array, offset: number): number {
  return viewOf(data).getUint32(offset, false);
}

/**
 * 写入大端 32 位无符号整数
 */
export function writeU32BE(data: Uint8Array, offset: number, value: number): void {
  viewOf(data).setUint32(offset, value, false);
}

/**
 * 读取小端 32 位无符号整数
 */
export function readU32LE(data: Uint8Array, offset: number): number {
  return viewOf(data).getUint32(offset, true);
}

/**
 * 读取大端 64 位无符号整数
 */
export function readU64BE(data: Uint8Array, offset: number): bigint {
  return viewOf(data).getBigUint64(offset, false);
}

/**
 * 写入大端 64 位无符号整数
 */
export function writeU64BE(data: Uint8Array, offset: number, value: bigint): void {
  viewOf(data).setBigUint64(offset, value, false);
}

/**
 * 从 node:fs readFileSync、ArrayBuffer 等边界读取结果转为独立 Uint8Array
 */
export function toUint8Array(data: Uint8Array | ArrayBuffer): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
