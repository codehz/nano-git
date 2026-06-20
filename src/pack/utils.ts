/**
 * Packfile 工具函数
 *
 * 提供 Packfile 格式中使用的各种编解码工具：
 * - 变长整数（variable-length integer）编码/解码
 * - 对象头部编码/解码
 * - ofs_delta 偏移量编码/解码
 *
 * Git Packfile 使用特殊的变长整数编码来节省空间。
 * 每个字节的最高位（MSB）表示是否还有后续字节，
 * 其余 7 位存储实际数据。
 */

import { InvalidPackError } from "../errors.ts";

// ============================================================================
// 对象头部编码/解码
// ============================================================================

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
 * // type = 3 (blob), size = 11, bytesRead = 1
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

  // 如果最高位为 1，继续读取后续字节
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
 * const header = encodeObjectHeader(3, 11); // blob, size 11
 * // => Buffer([0x3b])  // 0011 1011
 * ```
 */
export function encodeObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];

  // 第 1 字节：高 3 位类型 + 低 4 位大小
  let byte = ((type & 0x07) << 4) | (size & 0x0f);
  size >>>= 4;

  if (size > 0) {
    byte |= 0x80; // 设置继续标志
  }

  bytes.push(byte);

  // 后续字节：高 1 位继续标志 + 低 7 位大小
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

// ============================================================================
// ofs_delta 偏移量编码/解码
// ============================================================================

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
 */
export function encodeOfsDeltaOffset(offsetValue: number): Buffer {
  const bytes: number[] = [];

  // 从低位到高位编码
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

// ============================================================================
// 通用变长整数编码/解码
// ============================================================================

/**
 * 解码变长整数（通用版本）
 *
 * 用于 delta 指令中的变长整数，每个字节高 1 位是继续标志，
 * 低 7 位是数据，小端序。
 *
 * @param buf - 数据缓冲区
 * @param offset - 起始偏移量
 * @returns [值, 消耗的字节数]
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
