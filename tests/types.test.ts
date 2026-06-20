/**
 * core/types.ts 单元测试
 *
 * 测试 SHA1 branded type 的辅助函数
 */

import { describe, test, expect } from "bun:test";
import { sha1 } from "../src/core/types.ts";

describe("sha1()", () => {
  test("合法的 SHA-1 哈希应通过校验", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    expect(sha1(hash)).toBe(hash);
  });

  test("全零哈希应通过校验", () => {
    const hash = sha1("0000000000000000000000000000000000000000");
    expect(sha1(hash)).toBe(hash);
  });

  test("全 f 哈希应通过校验", () => {
    const hash = sha1("ffffffffffffffffffffffffffffffffffffffff");
    expect(sha1(hash)).toBe(hash);
  });

  test("长度不足 40 字符应抛出异常", () => {
    expect(() => sha1("95d09f2b10159347eece71399a7e2e907ea3df4")).toThrow("Invalid SHA-1 hash");
  });

  test("长度超过 40 字符应抛出异常", () => {
    expect(() => sha1("95d09f2b10159347eece71399a7e2e907ea3df4fa")).toThrow("Invalid SHA-1 hash");
  });

  test("包含大写字母应抛出异常", () => {
    expect(() => sha1("95D09F2B10159347EECE71399A7E2E907EA3DF4F")).toThrow("Invalid SHA-1 hash");
  });

  test("包含非十六进制字符应抛出异常", () => {
    expect(() => sha1("95d09f2b10159347eece71399a7e2e907ea3df4g")).toThrow("Invalid SHA-1 hash");
  });

  test("空字符串应抛出异常", () => {
    expect(() => sha1("")).toThrow("Invalid SHA-1 hash");
  });
});
