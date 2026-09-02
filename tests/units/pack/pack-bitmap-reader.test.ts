/**
 * Pack / MIDX bitmap v1 解析单元测试
 */

import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";

import {
  allocBytes,
  bytes,
  concatBytes,
  copyBytes,
  hexToBytes,
  writeU16BE,
  writeU32BE,
  writeU64BE,
  writeU8,
} from "../../helpers/bytes.ts";
import { createPackBitmapReader } from "@/pack/bitmap/pack-bitmap-reader.ts";

function appendEwah(buf: Uint8Array[], bitCount: number, runZeros: number): void {
  const part = allocBytes(8 + 8 + 4);
  writeU32BE(part, 0, bitCount);
  writeU32BE(part, 4, 1);
  writeU64BE(part, 8, BigInt(runZeros));
  writeU32BE(part, 16, 0);
  buf.push(part);
}

function buildMinimalBitmapV1(
  checksumHex: string,
  objectCount: number,
  entryCount: number,
): Uint8Array {
  const parts: Uint8Array[] = [];
  const header = allocBytes(32);
  copyBytes(header, 0, bytes("BITM"));
  writeU16BE(header, 4, 1);
  writeU16BE(header, 6, 0x0001); // FULL_DAG
  writeU32BE(header, 8, entryCount);
  copyBytes(header, 12, hexToBytes(checksumHex));
  parts.push(header);

  for (let t = 0; t < 4; t++) {
    appendEwah(parts, objectCount, objectCount);
  }

  for (let i = 0; i < entryCount; i++) {
    const entry = allocBytes(6);
    writeU32BE(entry, 0, i);
    writeU8(entry, 4, 0);
    writeU8(entry, 5, 0);
    parts.push(entry);
    const ewah = allocBytes(8 + 8 + 4);
    writeU32BE(ewah, 0, objectCount);
    writeU32BE(ewah, 4, 1);
    const rlw = (1n << 63n) | 1n;
    writeU64BE(ewah, 8, rlw);
    writeU32BE(ewah, 16, 0);
    parts.push(ewah);
  }

  const body = concatBytes(...parts);
  const trailer = createHash("sha1").update(body).digest();
  return concatBytes(body, trailer);
}

describe("createPackBitmapReader", () => {
  test("解析无 commit 条目的最小 bitmap", () => {
    const midxChecksum = "a".repeat(40);
    const data = buildMinimalBitmapV1(midxChecksum, 3, 0);
    const reader = createPackBitmapReader(data);
    expect(reader.checksumHex).toBe(midxChecksum);
    expect(reader.entryCount).toBe(0);
    expect(reader.bitCount).toBe(3);
  });

  test("XOR 链展开 commit 可达位图", () => {
    const midxChecksum = "b".repeat(40);
    const data = buildMinimalBitmapV1(midxChecksum, 2, 2);
    const reader = createPackBitmapReader(data);
    const bm0 = reader.getReachabilityBitmap(0);
    const bm1 = reader.getReachabilityBitmap(1);
    expect(bm0).toBeDefined();
    expect(bm1).toBeDefined();
    expect(bm0!.get(0)).toBe(true);
    expect(bm1!.get(0)).toBe(true);
  });
});
