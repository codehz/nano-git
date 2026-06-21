/**
 * core/hash.ts 单元测试
 *
 * 测试 SHA-1 哈希计算、路径转换、校验等功能
 */

import { describe, test, expect } from "bun:test";

import {
  hashData,
  hashObject,
  hashToPath,
  pathToHash,
  isValidSHA1,
} from "../../../src/core/hash.ts";
import { sha1 } from "../../../src/core/types.ts";

// ============================================================================
// hashData
// ============================================================================

describe("hashData()", () => {
  test("计算字符串的 SHA-1 哈希", () => {
    // "hello world" 的原始 SHA-1（不含 Git header）
    const hash = hashData("hello world");
    expect(hash).toBe(sha1("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed"));
  });

  test("计算 Buffer 的 SHA-1 哈希", () => {
    const hash = hashData(Buffer.from("hello world"));
    expect(hash).toBe(sha1("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed"));
  });

  test("空字符串的哈希", () => {
    const hash = hashData("");
    expect(hash).toBe(sha1("da39a3ee5e6b4b0d3255bfef95601890afd80709"));
  });

  test("相同输入产生相同哈希", () => {
    expect(hashData("test")).toBe(hashData("test"));
  });

  test("不同输入产生不同哈希", () => {
    expect(hashData("test1")).not.toBe(hashData("test2"));
  });
});

// ============================================================================
// hashObject
// ============================================================================

describe("hashObject()", () => {
  test("blob 对象的哈希 — hello world", () => {
    // 这是 Git 中最经典的哈希值
    const hash = hashObject("blob", Buffer.from("hello world"));
    expect(hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));
  });

  test("空 blob 的哈希", () => {
    // git hash-object -t blob --stdin <<< "" (不含换行)
    const hash = hashObject("blob", Buffer.from(""));
    expect(hash).toBe(sha1("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"));
  });

  test("相同内容相同类型产生相同哈希", () => {
    const content = Buffer.from("some content");
    expect(hashObject("blob", content)).toBe(hashObject("blob", content));
  });

  test("相同内容不同类型产生不同哈希", () => {
    const content = Buffer.from("test");
    const blobHash = hashObject("blob", content);
    // tree 和 commit 的内容格式不同，但 hashObject 只关心 header 中的 type
    // 所以相同内容 + 不同类型 = 不同哈希
    const treeHash = hashObject("tree", content);
    expect(blobHash).not.toBe(treeHash);
  });

  test("哈希格式为 40 位十六进制", () => {
    const hash = hashObject("blob", Buffer.from("test"));
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ============================================================================
// hashToPath / pathToHash
// ============================================================================

describe("hashToPath()", () => {
  test("将哈希转换为对象存储路径", () => {
    const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    expect(hashToPath(hash)).toBe("95/d09f2b10159347eece71399a7e2e907ea3df4f");
  });

  test("全零哈希的路径", () => {
    const hash = sha1("0000000000000000000000000000000000000000");
    expect(hashToPath(hash)).toBe("00/00000000000000000000000000000000000000");
  });
});

describe("pathToHash()", () => {
  test("从路径还原哈希", () => {
    const hash = pathToHash("95/d09f2b10159347eece71399a7e2e907ea3df4f");
    expect(hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));
  });

  test("hashToPath 和 pathToHash 互为逆操作", () => {
    const original = sha1("abcdef1234567890abcdef1234567890abcdef12");
    expect(pathToHash(hashToPath(original))).toBe(original);
  });
});

// ============================================================================
// isValidSHA1
// ============================================================================

describe("isValidSHA1()", () => {
  test("合法哈希返回 true", () => {
    expect(isValidSHA1("95d09f2b10159347eece71399a7e2e907ea3df4f")).toBe(true);
  });

  test("全零哈希返回 true", () => {
    expect(isValidSHA1("0000000000000000000000000000000000000000")).toBe(true);
  });

  test("太短返回 false", () => {
    expect(isValidSHA1("95d09f2b")).toBe(false);
  });

  test("太长返回 false", () => {
    expect(isValidSHA1("95d09f2b10159347eece71399a7e2e907ea3df4fa")).toBe(false);
  });

  test("包含大写字母返回 false", () => {
    expect(isValidSHA1("95D09F2B10159347EECE71399A7E2E907EA3DF4F")).toBe(false);
  });

  test("包含非十六进制字符返回 false", () => {
    expect(isValidSHA1("95d09f2b10159347eece71399a7e2e907ea3df4g")).toBe(false);
  });

  test("空字符串返回 false", () => {
    expect(isValidSHA1("")).toBe(false);
  });
});
