/**
 * Delta 创建（编码）
 */

import { encodeVarint } from "./utils.ts";

interface Match {
  offset: number;
  length: number;
}

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

  parts.push(encodeVarint(base.length));
  parts.push(encodeVarint(target.length));

  let targetOffset = 0;

  while (targetOffset < target.length) {
    const match = findBestMatch(base, target, targetOffset);

    if (match && match.length >= 4) {
      parts.push(encodeCopyInstruction(match.offset, match.length));
      targetOffset += match.length;
      continue;
    }

    let insertEnd = targetOffset + 1;
    while (insertEnd < target.length) {
      const nextMatch = findBestMatch(base, target, insertEnd);
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

function findBestMatch(base: Buffer, target: Buffer, targetOffset: number): Match | null {
  let bestMatch: Match | null = null;
  const maxLen = Math.min(target.length - targetOffset, 0xffff);

  for (let i = 0; i < base.length; i++) {
    if (base[i] !== target[targetOffset]) {
      continue;
    }

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
