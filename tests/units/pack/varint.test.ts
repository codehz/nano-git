/**
 * Packfile 变长整数编码/解码测试
 */

import { describe, test, expect } from "bun:test";

import {
  encodeObjectHeader,
  decodeObjectHeader,
  encodeOfsDeltaOffset,
  decodeOfsDeltaOffset,
  encodeVarint,
  decodeVarint,
} from "@/pack/utils.ts";

describe("变长整数编码", () => {
  test("编码和解码对象头部（小对象）", () => {
    const encoded = encodeObjectHeader(3, 11); // blob, size 11
    const [type, size, bytesRead] = decodeObjectHeader(encoded, 0);
    expect(type).toBe(3);
    expect(size).toBe(11);
    expect(bytesRead).toBe(1);
  });

  test("编码和解码对象头部（大对象）", () => {
    const encoded = encodeObjectHeader(1, 1000); // commit, size 1000
    const [type, size, bytesRead] = decodeObjectHeader(encoded, 0);
    expect(type).toBe(1);
    expect(size).toBe(1000);
    expect(bytesRead).toBeGreaterThan(1);
  });

  test("编码和解码 ofs_delta 偏移量", () => {
    const encoded = encodeOfsDeltaOffset(12345);
    const [offset, bytesRead] = decodeOfsDeltaOffset(encoded, 0);
    expect(offset).toBe(12345);
    expect(bytesRead).toBeGreaterThan(0);
  });

  test("编码和解码变长整数", () => {
    const values = [0, 1, 127, 128, 255, 1000, 65535, 1000000];
    for (const value of values) {
      const encoded = encodeVarint(value);
      const [decoded, bytesRead] = decodeVarint(encoded, 0);
      expect(decoded).toBe(value);
      expect(bytesRead).toBeGreaterThan(0);
    }
  });
});
