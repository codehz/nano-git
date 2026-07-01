/**
 * Pack / MIDX bitmap v1 解析单元测试
 */

import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";

import { createPackBitmapReader } from "@/pack/pack-bitmap-reader.ts";

function appendEwah(buf: Buffer[], bitCount: number, runZeros: number): void {
  const part = Buffer.alloc(8 + 8 + 4);
  part.writeUInt32BE(bitCount, 0);
  part.writeUInt32BE(1, 4);
  part.writeBigUInt64BE(BigInt(runZeros), 8);
  part.writeUInt32BE(0, 16);
  buf.push(part);
}

function buildMinimalBitmapV1(
  checksumHex: string,
  objectCount: number,
  entryCount: number,
): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(32);
  Buffer.from("BITM").copy(header, 0);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(0x0001, 6); // FULL_DAG
  header.writeUInt32BE(entryCount, 8);
  Buffer.from(checksumHex, "hex").copy(header, 12);
  parts.push(header);

  for (let t = 0; t < 4; t++) {
    appendEwah(parts, objectCount, objectCount);
  }

  for (let i = 0; i < entryCount; i++) {
    const entry = Buffer.alloc(6);
    entry.writeUInt32BE(i, 0);
    entry.writeUInt8(0, 4);
    entry.writeUInt8(0, 5);
    parts.push(entry);
    const ewah = Buffer.alloc(8 + 8 + 4);
    ewah.writeUInt32BE(objectCount, 0);
    ewah.writeUInt32BE(1, 4);
    const rlw = (1n << 63n) | 1n;
    ewah.writeBigUInt64BE(rlw, 8);
    ewah.writeUInt32BE(0, 16);
    parts.push(ewah);
  }

  const body = Buffer.concat(parts);
  const trailer = createHash("sha1").update(body).digest();
  return Buffer.concat([body, trailer]);
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
