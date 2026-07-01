/**
 * hash/path.ts 单元测试
 *
 * 覆盖 hashToPath / pathToHash / isValidSHA1
 */

import { describe, test, expect } from "bun:test";

import { hashToPath, pathToHash, isValidSHA1 } from "@/hash/path.ts";
import { sha1 } from "@/types/index.ts";

import type { SHA1 } from "@/types/index.ts";

const HASH = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");

describe("hashToPath()", () => {
  test("将完整哈希转换为对象路径", () => {
    expect(hashToPath(HASH)).toBe("95/d09f2b10159347eece71399a7e2e907ea3df4f");
  });

  test("全零哈希", () => {
    const zero = sha1("0000000000000000000000000000000000000000");
    expect(hashToPath(zero)).toBe("00/00000000000000000000000000000000000000");
  });

  test("路径总长度 = 2 + 1 + 38 = 41", () => {
    expect(hashToPath(HASH).length).toBe(41);
  });
});

describe("pathToHash()", () => {
  test("从对象路径还原哈希", () => {
    const path = "95/d09f2b10159347eece71399a7e2e907ea3df4f";
    expect(pathToHash(path)).toBe(HASH);
  });

  test("hashToPath 与 pathToHash 往返一致", () => {
    const testHashes: SHA1[] = [
      sha1("0000000000000000000000000000000000000000"),
      sha1("ffffffffffffffffffffffffffffffffffffffff"),
      sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"),
    ];
    for (const hash of testHashes) {
      expect(pathToHash(hashToPath(hash))).toBe(hash);
    }
  });
});

describe("isValidSHA1()", () => {
  test("有效 40 位十六进制字符串", () => {
    expect(isValidSHA1("95d09f2b10159347eece71399a7e2e907ea3df4f")).toBe(true);
  });

  test("全零哈希有效", () => {
    expect(isValidSHA1("0000000000000000000000000000000000000000")).toBe(true);
  });

  test("全 f 哈希有效", () => {
    expect(isValidSHA1("ffffffffffffffffffffffffffffffffffffffff")).toBe(true);
  });

  test("包含大写字母无效", () => {
    expect(isValidSHA1("ABCDEF0123456789ABCDEF0123456789ABCDEF01")).toBe(false);
  });

  test("长度不足无效", () => {
    expect(isValidSHA1("95d09f2b10159347eece71399a7e2e907ea3df4")).toBe(false);
  });

  test("长度超长无效", () => {
    expect(isValidSHA1("95d09f2b10159347eece71399a7e2e907ea3df4ff")).toBe(false);
  });

  test("包含非十六进制字符无效", () => {
    expect(isValidSHA1("95d09f2b10159347eece71399a7e2e907ea3df4g")).toBe(false);
  });

  test("空字符串无效", () => {
    expect(isValidSHA1("")).toBe(false);
  });

  test("返回类型应为类型保护（type predicate）", () => {
    const value: string = "95d09f2b10159347eece71399a7e2e907ea3df4f";
    if (isValidSHA1(value)) {
      // 此处 value 应被收窄为 SHA1
      const hash: SHA1 = value;
      expect(hashToPath(hash)).toBe("95/d09f2b10159347eece71399a7e2e907ea3df4f");
    }
  });
});
