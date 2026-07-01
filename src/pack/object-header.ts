/**
 * Packfile 对象头部编码/解码
 */

import { InvalidPackError } from "../errors.ts";

/**
 * 解码 Packfile 对象头部的变长整数
 *
 * 对象头部格式：
 * - 第 1 字节：高 3 位是类型，低 4 位是大小
 * - 后续字节：高 1 位是继续标志，低 7 位是大小
 *
 * @param buf - 数据缓冲区
 * @param offset - 起始偏移量
 * @returns [类型编号, 大小, 消耗的字节数]
 *
 * @example
 * ```ts
 * const [type, size, bytesRead] = decodeObjectHeader(buf, 0);
 * ```
 */
export function decodeObjectHeader(
  buf: Buffer,
  offset: number,
): [type: number, size: number, bytesRead: number] {
  if (offset >= buf.length) {
    throw new InvalidPackError("Unexpected end of data in object header");
  }

  const firstByte = buf[offset]!;
  const type = (firstByte >> 4) & 0x07;
  let size = firstByte & 0x0f;
  let shift = 4;
  let bytesRead = 1;

  if (firstByte & 0x80) {
    let byte: number;
    do {
      if (offset + bytesRead >= buf.length) {
        throw new InvalidPackError("Unexpected end of data in variable-length integer");
      }
      byte = buf[offset + bytesRead]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
      bytesRead++;
    } while (byte & 0x80);
  }

  return [type, size, bytesRead];
}

/**
 * 编码 Packfile 对象头部的变长整数
 *
 * @param type - 对象类型编号（1-7）
 * @param size - 对象大小
 * @returns 编码后的字节缓冲区
 *
 * @example
 * ```ts
 * const header = encodeObjectHeader(3, 11);
 * ```
 */
export function encodeObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];

  let byte = ((type & 0x07) << 4) | (size & 0x0f);
  size >>>= 4;

  if (size > 0) {
    byte |= 0x80;
  }

  bytes.push(byte);

  while (size > 0) {
    byte = size & 0x7f;
    size >>>= 7;
    if (size > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  }

  return Buffer.from(bytes);
}
