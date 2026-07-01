/**
 * pack/object-header.ts 单元测试
 */

import { describe, test, expect } from "bun:test";

import { InvalidPackError } from "@/errors.ts";
import { decodeObjectHeader, encodeObjectHeader } from "@/pack/utils/object-header.ts";

describe("decodeObjectHeader()", () => {
  test("解码单字节头部（小对象）", () => {
    // type=1 (commit), size=7
    // 0001_0111 = 0x17
    const buf = Buffer.from([0b0001_0111]);
    const [type, size, bytesRead] = decodeObjectHeader(buf, 0);
    expect(type).toBe(1);
    expect(size).toBe(7);
    expect(bytesRead).toBe(1);
  });

  test("解码双字节头部", () => {
    // type=3 (blob), size=0x90 (144)
    // first byte: type=3 << 4 | size & 0xf = 0x30 | 0x00 = 0x30, with continue bit
    // size >>= 4 = 9
    // second byte: 0x09
    const buf = Buffer.from([0b0011_0000 | 0b1000_0000, 0b0000_1001]);
    const [type, size, bytesRead] = decodeObjectHeader(buf, 0);
    expect(type).toBe(3);
    expect(size).toBe(144);
    expect(bytesRead).toBe(2);
  });

  test("解码多字节头部（大对象）", () => {
    // type=3 (blob), size=0x2000 (8192)
    // encoded by encodeObjectHeader(3, 0x2000):
    // byte1: 0x30 | 0x80 = 0xb0 (type=3, size=0x00, continue)
    // byte2: 0x00 | 0x80 = 0x80 (size=0x200, continue)
    // byte3: 0x04 (size=0x04, no continue)
    const buf = Buffer.from([0b0011_0000 | 0b1000_0000, 0b0000_0000 | 0b1000_0000, 0b0000_0100]);
    const [type, size, bytesRead] = decodeObjectHeader(buf, 0);
    expect(type).toBe(3);
    expect(size).toBe(0x2000);
    expect(bytesRead).toBe(3);
  });

  test("空缓冲区抛出异常", () => {
    const buf = Buffer.from([]);
    expect(() => decodeObjectHeader(buf, 0)).toThrow(InvalidPackError);
  });

  test("不完整的变长整数抛出异常", () => {
    // 只有 continue bit 但没有后续字节
    const buf = Buffer.from([0b1000_0000]);
    expect(() => decodeObjectHeader(buf, 0)).toThrow(InvalidPackError);
  });
});

describe("encodeObjectHeader()", () => {
  test("编码小对象（单字节）", () => {
    const header = encodeObjectHeader(1, 7);
    expect(header).toEqual(Buffer.from([0b0001_0111]));
  });

  test("编码需要双字节的对象", () => {
    const header = encodeObjectHeader(3, 144);
    expect(header).toHaveLength(2);
    expect(header[0]! & 0x80).toBe(0x80); // continue bit set
  });

  test("编码-解码往返一致性", () => {
    const cases: [number, number][] = [
      [1, 7],
      [2, 100],
      [3, 1000],
      [4, 50000],
      [1, 1],
      [7, 0],
    ];
    for (const [type, size] of cases) {
      const encoded = encodeObjectHeader(type, size);
      const [decodedType, decodedSize] = decodeObjectHeader(encoded, 0);
      expect(decodedType!).toBe(type);
      expect(decodedSize!).toBe(size);
    }
  });
});
