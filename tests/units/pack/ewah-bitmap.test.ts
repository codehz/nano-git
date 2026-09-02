/**
 * EWAH 位图解码单元测试
 */

import { describe, test, expect } from "bun:test";

import { allocBytes, writeU32BE, writeU64BE } from "../../helpers/bytes.ts";
import { decodeEwahBitmap } from "@/pack/bitmap/ewah-bitmap.ts";

/** 构造仅含一个 RLW（run of 3 zeros）的 EWAH 块 */
function buildEwahRunZeros(bitCount: number, runLength: number): Uint8Array {
  const wordCount = 1;
  const rlw = BigInt(runLength); // repeated bit 0, literals 0
  const buf = allocBytes(8 + 8 + 4);
  writeU32BE(buf, 0, bitCount);
  writeU32BE(buf, 4, wordCount);
  writeU64BE(buf, 8, rlw);
  writeU32BE(buf, 16, 0);
  return buf;
}

describe("decodeEwahBitmap", () => {
  test("解码全零 run", () => {
    const data = buildEwahRunZeros(5, 5);
    const { bitmap } = decodeEwahBitmap(data, 0);
    expect(bitmap.bitCount).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(bitmap.get(i)).toBe(false);
    }
  });

  test("解码含置位的 literal word", () => {
    const bitCount = 4;
    const rlw = 0n; // no run
    const literal = 0b0101n;
    const buf = allocBytes(8 + 8 + 8 + 4);
    writeU32BE(buf, 0, bitCount);
    writeU32BE(buf, 4, 2);
    writeU64BE(buf, 8, rlw | (1n << 32n));
    writeU64BE(buf, 16, literal);
    writeU32BE(buf, 24, 1);

    const { bitmap } = decodeEwahBitmap(buf, 0);
    expect(bitmap.get(0)).toBe(true);
    expect(bitmap.get(1)).toBe(false);
    expect(bitmap.get(2)).toBe(true);
    expect(bitmap.get(3)).toBe(false);
  });
});
