/**
 * pack/ofs-delta-offset.ts 单元测试
 */

import { describe, test, expect } from "bun:test";

import { InvalidPackError } from "@/errors.ts";
import { decodeOfsDeltaOffset, encodeOfsDeltaOffset } from "@/pack/ofs-delta-offset.ts";

describe("decodeOfsDeltaOffset()", () => {
  test("解码单字节偏移量", () => {
    // value=5, without continue bit
    const buf = Buffer.from([0b0000_0101]);
    const [value, bytesRead] = decodeOfsDeltaOffset(buf, 0);
    expect(value).toBe(5);
    expect(bytesRead).toBe(1);
  });

  test("解码双字节偏移量", () => {
    // encodeOfsDeltaOffset(128) produces [0x80, 0x00]
    const buf = Buffer.from([0x80, 0x00]);
    const [value, bytesRead] = decodeOfsDeltaOffset(buf, 0);
    expect(value).toBe(128);
    expect(bytesRead).toBe(2);
  });

  test("空缓冲区抛出异常", () => {
    const buf = Buffer.from([]);
    expect(() => decodeOfsDeltaOffset(buf, 0)).toThrow(InvalidPackError);
  });

  test("不完整的变长整数抛出异常", () => {
    const buf = Buffer.from([0x80]);
    expect(() => decodeOfsDeltaOffset(buf, 0)).toThrow(InvalidPackError);
  });
});

describe("encodeOfsDeltaOffset()", () => {
  test("编码小偏移量", () => {
    const encoded = encodeOfsDeltaOffset(5);
    expect(encoded).toEqual(Buffer.from([0b0000_0101]));
  });

  test("编码-解码往返一致性", () => {
    const values = [0, 1, 10, 127, 128, 255, 1000, 50000, 1000000];
    for (const value of values) {
      const encoded = encodeOfsDeltaOffset(value);
      const [decoded, bytesRead] = decodeOfsDeltaOffset(encoded, 0);
      expect(decoded).toBe(value);
      expect(bytesRead).toBe(encoded.length);
    }
  });
});
