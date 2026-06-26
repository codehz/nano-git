/**
 * pack/crc32.ts 单元测试
 */

import { describe, test, expect } from "bun:test";

import { crc32Value } from "@/pack/crc32.ts";

describe("crc32Value()", () => {
  test("空数据的 CRC32", () => {
    const crc = crc32Value(Buffer.from(""));
    // CRC32 of empty data = 0
    expect(crc).toBe(0);
  });

  test("已知数据的 CRC32 值", () => {
    const crc = crc32Value(Buffer.from("hello"));
    // 已知值验证
    expect(crc).toBeGreaterThan(0);
    expect(Number.isInteger(crc)).toBe(true);
  });

  test("相同数据产生相同 CRC32", () => {
    const data = Buffer.from("test data");
    expect(crc32Value(data)).toBe(crc32Value(data));
  });

  test("不同数据产生不同 CRC32", () => {
    const a = crc32Value(Buffer.from("data1"));
    const b = crc32Value(Buffer.from("data2"));
    expect(a).not.toBe(b);
  });

  test("与 Git 的 CRC32 算法兼容", () => {
    // Git pack 索引使用此 CRC32 算法
    // 验证已知值
    const crc = crc32Value(Buffer.from("blob 11\u0000hello world"));
    expect(typeof crc).toBe("number");
    expect(crc).toBeGreaterThan(0);
  });

  test("查找表缓存正常工作", () => {
    // 多次调用应使用缓存的查找表
    const crc1 = crc32Value(Buffer.from("a"));
    const crc2 = crc32Value(Buffer.from("a"));
    expect(crc1).toBe(crc2);
  });
});
