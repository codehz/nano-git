/**
 * Packfile 通用变长整数编码/解码
 */

import { InvalidPackError } from "../../errors.ts";

/**
 * 解码变长整数（通用版本）
 *
 * 用于 delta 指令中的变长整数，每个字节高 1 位是继续标志，
 * 低 7 位是数据，小端序。
 *
 * @param buf - 数据缓冲区
 * @param offset - 起始偏移量
 * @returns [值, 消耗的字节数]
 *
 * @example
 * ```ts
 * const [value, bytesRead] = decodeVarint(buf, 0);
 * ```
 */
export function decodeVarint(buf: Buffer, offset: number): [value: number, bytesRead: number] {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  let byte: number;

  do {
    if (offset + bytesRead >= buf.length) {
      throw new InvalidPackError("Unexpected end of data in varint");
    }
    byte = buf[offset + bytesRead]!;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    bytesRead++;
  } while (byte & 0x80);

  return [value, bytesRead];
}

/**
 * 编码变长整数（通用版本）
 *
 * @param value - 要编码的值
 * @returns 编码后的字节缓冲区
 *
 * @example
 * ```ts
 * const encoded = encodeVarint(123);
 * ```
 */
export function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];

  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (value > 0);

  return Buffer.from(bytes);
}
