/**
 * Packfile ofs_delta 偏移量编码/解码
 */

import { InvalidPackError } from "../../errors.ts";

/**
 * 解码 ofs_delta 的负偏移量
 *
 * ofs_delta 使用特殊的变长编码表示相对于当前对象的偏移量。
 * 编码方式：每个字节的最高位是继续标志，低 7 位是数据。
 * 后续字节需要先加 1 再左移，以支持更大的偏移量。
 *
 * @param buf - 数据缓冲区
 * @param offset - 起始偏移量
 * @returns [偏移量, 消耗的字节数]
 *
 * @example
 * ```ts
 * const [value, bytesRead] = decodeOfsDeltaOffset(buf, 0);
 * ```
 */
export function decodeOfsDeltaOffset(
  buf: Buffer,
  offset: number,
): [offsetValue: number, bytesRead: number] {
  if (offset >= buf.length) {
    throw new InvalidPackError("Unexpected end of data in ofs_delta offset");
  }

  let byte = buf[offset]!;
  let value = byte & 0x7f;
  let bytesRead = 1;

  while (byte & 0x80) {
    if (offset + bytesRead >= buf.length) {
      throw new InvalidPackError("Unexpected end of data in ofs_delta offset");
    }
    byte = buf[offset + bytesRead]!;
    value = ((value + 1) << 7) | (byte & 0x7f);
    bytesRead++;
  }

  return [value, bytesRead];
}

/**
 * 编码 ofs_delta 的负偏移量
 *
 * @param offsetValue - 偏移量（正数，表示向后偏移的字节数）
 * @returns 编码后的字节缓冲区
 *
 * @example
 * ```ts
 * const encoded = encodeOfsDeltaOffset(123);
 * ```
 */
export function encodeOfsDeltaOffset(offsetValue: number): Buffer {
  const bytes: number[] = [];

  let value = offsetValue;
  bytes.unshift(value & 0x7f);
  value >>>= 7;

  while (value > 0) {
    value--;
    bytes.unshift((value & 0x7f) | 0x80);
    value >>>= 7;
  }

  return Buffer.from(bytes);
}
