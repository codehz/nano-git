/**
 * Delta 对象编解码
 *
 * Git Packfile 中的 delta 对象存储的是相对于另一个对象（base object）的差异。
 * 有两种 delta 类型：
 * - ofs_delta：base object 通过偏移量引用（在同一个 packfile 中）
 * - ref_delta：base object 通过 SHA-1 哈希引用（可能在其他 packfile 中）
 *
 * Delta 数据格式：
 * 1. 源对象大小（变长整数）
 * 2. 目标对象大小（变长整数）
 * 3. 指令序列：
 *    - 复制指令（最高位为 1）：从源对象复制数据到目标
 *    - 插入指令（最高位为 0）：从 delta 数据中插入新数据到目标
 *
 * @example
 * ```ts
 * // 应用 delta 到 base object
 * const result = applyDelta(baseData, deltaData);
 * ```
 */

import { DeltaError } from "../errors.ts";
import { decodeVarint, encodeVarint } from "./utils.ts";

// ============================================================================
// Delta 应用（解码）
// ============================================================================

/**
 * 将 delta 数据应用到 base object，生成目标对象
 *
 * @param base - base object 的原始数据
 * @param delta - delta 数据
 * @returns 目标对象的原始数据
 *
 * @example
 * ```ts
 * const base = Buffer.from("hello world");
 * const delta = createDelta(base, Buffer.from("hello git"));
 * const result = applyDelta(base, delta);
 * // result => Buffer("hello git")
 * ```
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;

  // 读取源对象大小（仅用于验证）
  const [_srcSize, srcBytes] = decodeVarint(delta, offset);
  offset += srcBytes;

  // 读取目标对象大小
  const [destSize, destBytes] = decodeVarint(delta, offset);
  offset += destBytes;

  const result = Buffer.alloc(destSize);
  let destOffset = 0;

  // 处理指令序列
  while (offset < delta.length) {
    const cmd = delta[offset]!;
    offset++;

    if (cmd & 0x80) {
      // 复制指令：从 base 复制数据
      let copyOffset = 0;
      let copySize = 0;

      if (cmd & 0x01) copyOffset = delta[offset++]!;
      if (cmd & 0x02) copyOffset |= delta[offset++]! << 8;
      if (cmd & 0x04) copyOffset |= delta[offset++]! << 16;
      if (cmd & 0x08) copyOffset |= delta[offset++]! << 24;

      if (cmd & 0x10) copySize = delta[offset++]!;
      if (cmd & 0x20) copySize |= delta[offset++]! << 8;
      if (cmd & 0x40) copySize |= delta[offset++]! << 16;

      // 大小为 0 表示 0x10000
      if (copySize === 0) copySize = 0x10000;

      if (copyOffset + copySize > base.length) {
        throw new DeltaError(
          `Copy out of bounds: offset=${copyOffset}, size=${copySize}, base.length=${base.length}`,
        );
      }

      base.copy(result, destOffset, copyOffset, copyOffset + copySize);
      destOffset += copySize;
    } else if (cmd > 0) {
      // 插入指令：从 delta 数据中插入 cmd 个字节
      if (offset + cmd > delta.length) {
        throw new DeltaError("Insert out of bounds");
      }

      delta.copy(result, destOffset, offset, offset + cmd);
      destOffset += cmd;
      offset += cmd;
    } else {
      throw new DeltaError("Unexpected delta command: 0");
    }
  }

  if (destOffset !== destSize) {
    throw new DeltaError(`Delta size mismatch: expected ${destSize}, got ${destOffset}`);
  }

  return result;
}

// ============================================================================
// Delta 创建（编码）
// ============================================================================

/**
 * 创建 delta 数据（从 base object 到 target object 的差异）
 *
 * 使用简单的贪心策略：在 base 中查找与 target 当前位置匹配的最长子串。
 * 这是一个简化实现，不追求最优压缩率。
 *
 * @param base - base object 的原始数据
 * @param target - 目标对象的原始数据
 * @returns delta 数据
 *
 * @example
 * ```ts
 * const base = Buffer.from("hello world");
 * const target = Buffer.from("hello git");
 * const delta = createDelta(base, target);
 * ```
 */
export function createDelta(base: Buffer, target: Buffer): Buffer {
  const parts: Buffer[] = [];

  // 写入源对象大小
  parts.push(encodeVarint(base.length));
  // 写入目标对象大小
  parts.push(encodeVarint(target.length));

  let targetOffset = 0;

  while (targetOffset < target.length) {
    // 在 base 中查找与 target 当前位置匹配的最长子串
    const match = findBestMatch(base, target, targetOffset);

    if (match && match.length >= 4) {
      // 使用复制指令
      parts.push(encodeCopyInstruction(match.offset, match.length));
      targetOffset += match.length;
    } else {
      // 使用插入指令：找到下一个可以匹配的位置之前的所有字节
      let insertEnd = targetOffset + 1;
      while (insertEnd < target.length) {
        const nextMatch = findBestMatch(base, target, insertEnd);
        if (nextMatch && nextMatch.length >= 4) break;
        insertEnd++;
        // 插入指令最多 127 字节
        if (insertEnd - targetOffset >= 127) break;
      }

      const insertSize = insertEnd - targetOffset;
      parts.push(Buffer.from([insertSize]));
      parts.push(target.subarray(targetOffset, insertEnd));
      targetOffset = insertEnd;
    }
  }

  return Buffer.concat(parts);
}

// ============================================================================
// 内部辅助函数
// ============================================================================

/** 匹配结果 */
interface Match {
  /** 在 base 中的偏移量 */
  offset: number;
  /** 匹配长度 */
  length: number;
}

/**
 * 在 base 中查找与 target 从 targetOffset 开始的最长匹配
 */
function findBestMatch(base: Buffer, target: Buffer, targetOffset: number): Match | null {
  let bestMatch: Match | null = null;
  const maxLen = Math.min(target.length - targetOffset, 0xffff);

  // 简单暴力搜索（生产环境应使用更高效的算法如 suffix array）
  for (let i = 0; i < base.length; i++) {
    if (base[i] !== target[targetOffset]) continue;

    let len = 0;
    while (len < maxLen && i + len < base.length && base[i + len] === target[targetOffset + len]) {
      len++;
    }

    if (len >= 4 && (!bestMatch || len > bestMatch.length)) {
      bestMatch = { offset: i, length: len };
    }
  }

  return bestMatch;
}

/**
 * 编码复制指令
 *
 * 复制指令格式：
 * - 第 1 字节：最高位为 1，低 7 位标记后续哪些字节存在
 * - 后续 0-7 字节：偏移量（4 字节）和大小（3 字节）
 */
function encodeCopyInstruction(offset: number, size: number): Buffer {
  const bytes: number[] = [];
  let cmd = 0x80; // 复制指令标志

  const offsetBytes: number[] = [];
  if (offset & 0xff) {
    cmd |= 0x01;
    offsetBytes.push(offset & 0xff);
  }
  if (offset & 0xff00) {
    cmd |= 0x02;
    offsetBytes.push((offset >> 8) & 0xff);
  }
  if (offset & 0xff0000) {
    cmd |= 0x04;
    offsetBytes.push((offset >> 16) & 0xff);
  }
  if (offset & 0xff000000) {
    cmd |= 0x08;
    offsetBytes.push((offset >> 24) & 0xff);
  }

  const sizeBytes: number[] = [];
  // 大小为 0x10000 时编码为 0
  if (size !== 0x10000) {
    if (size & 0xff) {
      cmd |= 0x10;
      sizeBytes.push(size & 0xff);
    }
    if (size & 0xff00) {
      cmd |= 0x20;
      sizeBytes.push((size >> 8) & 0xff);
    }
    if (size & 0xff0000) {
      cmd |= 0x40;
      sizeBytes.push((size >> 16) & 0xff);
    }
  }

  bytes.push(cmd);
  bytes.push(...offsetBytes, ...sizeBytes);

  return Buffer.from(bytes);
}
