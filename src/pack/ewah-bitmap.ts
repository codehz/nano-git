/**
 * EWAH 压缩位图解码（与 JGit / Git pack-bitmap 兼容）
 *
 * @see Documentation/technical/bitmap-format.adoc — Appendix A
 */

import { PackIndexError } from "../core/errors.ts";

/**
 * 解压后的位图（只读）
 */
export interface UnpackedBitmap {
  /** 位数量 */
  readonly bitCount: number;
  /** 测试第 i 位是否为 1 */
  get(bitIndex: number): boolean;
  /** 与另一张位图按位 OR（长度取较大者） */
  or(other: UnpackedBitmap): UnpackedBitmap;
}

/**
 * 从缓冲区解码一块 EWAH 位图
 *
 * @param data - 完整文件或切片
 * @param offset - EWAH 块起始偏移
 * @returns 解压位图与消费的字节数
 */
export function decodeEwahBitmap(
  data: Buffer,
  offset: number,
): { bitmap: UnpackedBitmap; bytesRead: number } {
  if (offset + 12 > data.length) {
    throw new PackIndexError("EWAH bitmap truncated");
  }

  const bitCount = data.readUInt32BE(offset);
  const wordCount = data.readUInt32BE(offset + 4);
  const wordsStart = offset + 8;
  const wordsEnd = wordsStart + wordCount * 8;

  if (wordsEnd + 4 > data.length) {
    throw new PackIndexError("EWAH bitmap words truncated");
  }

  const rlwPosition = data.readUInt32BE(wordsEnd);
  if (rlwPosition > wordCount) {
    throw new PackIndexError(`EWAH invalid RLW position: ${rlwPosition}`);
  }

  const words: bigint[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(data.readBigUInt64BE(wordsStart + i * 8));
  }

  const bits = unpackEwahWords(words, bitCount);
  const bytesRead = wordsEnd + 4 - offset;

  return {
    bitmap: createUnpackedBitmap(bits, bitCount),
    bytesRead,
  };
}

function createUnpackedBitmap(bits: Uint8Array, bitCount: number): UnpackedBitmap {
  return {
    bitCount,
    get(bitIndex: number): boolean {
      if (bitIndex < 0 || bitIndex >= bitCount) {
        return false;
      }
      const byte = bits[bitIndex >> 3]!;
      return (byte & (1 << (bitIndex & 7))) !== 0;
    },
    or(other: UnpackedBitmap): UnpackedBitmap {
      const max = Math.max(bitCount, other.bitCount);
      const out = new Uint8Array((max + 7) >> 3);
      for (let i = 0; i < max; i++) {
        if (getBit(bits, bitCount, i) || other.get(i)) {
          out[i >> 3]! |= 1 << (i & 7);
        }
      }
      return createUnpackedBitmap(out, max);
    },
  };
}

function getBit(bits: Uint8Array, bitCount: number, index: number): boolean {
  if (index < 0 || index >= bitCount) {
    return false;
  }
  return (bits[index >> 3]! & (1 << (index & 7))) !== 0;
}

function unpackEwahWords(words: bigint[], bitCount: number): Uint8Array {
  const out = new Uint8Array((bitCount + 7) >> 3);
  let wordIndex = 0;
  let outBit = 0;

  while (wordIndex < words.length && outBit < bitCount) {
    const rlw = words[wordIndex]!;
    wordIndex++;

    const repeatedBit = Number((rlw >> 63n) & 1n);
    const runLength = Number(rlw & 0xffffffffn);
    const literalCount = Number((rlw >> 32n) & 0x7fffffffn);

    for (let i = 0; i < runLength && outBit < bitCount; i++) {
      if (repeatedBit !== 0) {
        setBit(out, outBit);
      }
      outBit++;
    }

    for (let lit = 0; lit < literalCount && wordIndex < words.length; lit++) {
      const w = words[wordIndex]!;
      wordIndex++;
      for (let b = 0; b < 64 && outBit < bitCount; b++) {
        if ((w >> BigInt(b)) & 1n) {
          setBit(out, outBit);
        }
        outBit++;
      }
    }
  }

  return out;
}

function setBit(out: Uint8Array, bitIndex: number): void {
  out[bitIndex >> 3]! |= 1 << (bitIndex & 7);
}

export function xorUnpackedBitmaps(a: UnpackedBitmap, b: UnpackedBitmap): UnpackedBitmap {
  const max = Math.max(a.bitCount, b.bitCount);
  const bits = new Uint8Array((max + 7) >> 3);
  for (let i = 0; i < max; i++) {
    if (a.get(i) !== b.get(i)) {
      bits[i >> 3]! |= 1 << (i & 7);
    }
  }
  return createUnpackedBitmap(bits, max);
}
