/**
 * Delta 创建（编码）
 *
 * 使用哈希表（Rabin-Karp 风格）加速模式匹配：
 * - 预处理 base 中所有 4 字节窗口，构建哈希索引
 * - 对 target 的每个位置，通过哈希表 O(1) 定位候选匹配
 * - 平均时间复杂度 O(B+T)，最坏 O(B×T×K)（K 为每桶候选数上限）
 */

import { encodeVarint } from "./utils.ts";

interface Match {
  offset: number;
  length: number;
}

/**
 * 创建 delta 数据（从 base object 到 target object 的差异）
 *
 * 使用哈希表加速贪心匹配策略，相比暴力扫描大幅减少匹配搜索开销。
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

  parts.push(encodeVarint(base.length));
  parts.push(encodeVarint(target.length));

  const hashTable = buildHashTable(base);

  let targetOffset = 0;

  while (targetOffset < target.length) {
    const match = findBestMatch(base, target, targetOffset, hashTable);

    if (match && match.length >= 4) {
      parts.push(encodeCopyInstruction(match.offset, match.length));
      targetOffset += match.length;
      continue;
    }

    let insertEnd = targetOffset + 1;
    while (insertEnd < target.length) {
      const nextMatch = findBestMatch(base, target, insertEnd, hashTable);
      if (nextMatch && nextMatch.length >= 4) {
        break;
      }

      insertEnd++;
      if (insertEnd - targetOffset >= 127) {
        break;
      }
    }

    const insertSize = insertEnd - targetOffset;
    parts.push(Buffer.from([insertSize]));
    parts.push(target.subarray(targetOffset, insertEnd));
    targetOffset = insertEnd;
  }

  return Buffer.concat(parts);
}

// ============================================================================
// 哈希表加速匹配
// ============================================================================

/** 每个哈希值保留的最大候选位置数（防止重复字符串退化） */
const MAX_CANDIDATES_PER_HASH = 32;

/**
 * 构建 4 字节窗口哈希表
 *
 * 将 base 中每个 4 字节子串的精确值作为哈希键，
 * 映射到出现该子串的偏移量列表。
 */
function buildHashTable(base: Buffer): Map<number, number[]> {
  const table = new Map<number, number[]>();

  for (let i = 0; i <= base.length - 4; i++) {
    const hash = hash4(base, i);
    let positions = table.get(hash);
    if (!positions) {
      positions = [];
      table.set(hash, positions);
    }
    if (positions.length < MAX_CANDIDATES_PER_HASH) {
      positions.push(i);
    }
  }

  return table;
}

/**
 * 计算 Buffer 中 4 字节窗口的 32 位哈希值
 *
 * 使用精确的 4 字节值（大端序）作为哈希，保证相同 4 字节序列得到相同值。
 */
function hash4(buf: Buffer, offset: number): number {
  return (
    ((buf[offset]! << 24) |
      (buf[offset + 1]! << 16) |
      (buf[offset + 2]! << 8) |
      buf[offset + 3]!) >>>
    0
  );
}

/**
 * 使用哈希表查找与 target[targetOffset] 开始的最长匹配
 *
 * 只在哈希表中存在对应 4 字节前缀的位置上搜索匹配并扩展，
 * 替代原实现的暴力全量扫描。
 *
 * @param hashTable - buildHashTable 构建的哈希表
 */
function findBestMatch(
  base: Buffer,
  target: Buffer,
  targetOffset: number,
  hashTable: Map<number, number[]>,
): Match | null {
  if (targetOffset + 4 > target.length) {
    return null;
  }

  const targetHash = hash4(target, targetOffset);
  const candidates = hashTable.get(targetHash);
  if (!candidates || candidates.length === 0) {
    return null;
  }

  let bestMatch: Match | null = null;
  const maxLen = Math.min(target.length - targetOffset, 0xffff);

  for (const baseOffset of candidates) {
    // 4 字节前缀已由哈希匹配保证，从第 5 字节开始扩展
    let len = 4;
    while (
      len < maxLen &&
      baseOffset + len < base.length &&
      base[baseOffset + len] === target[targetOffset + len]
    ) {
      len++;
    }

    if (len > (bestMatch?.length ?? 0)) {
      bestMatch = { offset: baseOffset, length: len };
      if (len === maxLen) {
        break;
      }
    }
  }

  return bestMatch;
}

function encodeCopyInstruction(offset: number, size: number): Buffer {
  const bytes: number[] = [];
  let cmd = 0x80;

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
