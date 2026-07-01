/**
 * core/hash-digest.ts 单元测试
 *
 * 覆盖 hashData / hashObject
 */

import { describe, test, expect } from "bun:test";

import { hashData, hashObject } from "@/hash/digest.ts";
import { sha1 } from "@/types/index.ts";

describe("hashData()", () => {
  test("计算字符串的 SHA-1", () => {
    expect(hashData("hello")).toBe(sha1("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d"));
  });

  test("相同输入产生相同哈希", () => {
    expect(hashData("test")).toBe(hashData("test"));
  });

  test("不同输入产生不同哈希", () => {
    expect(hashData("hello")).not.toBe(hashData("world"));
  });

  test("计算 Buffer 的 SHA-1", () => {
    const buf = Buffer.from("buffer data");
    const result = hashData(buf);
    expect(result).toBe(sha1("aa0ad343ea72acb21a796416694b2895dc06e42d"));
  });

  test("空字符串", () => {
    expect(hashData("")).toBe(sha1("da39a3ee5e6b4b0d3255bfef95601890afd80709"));
  });
});

describe("hashObject()", () => {
  test("计算 blob 对象的哈希", () => {
    const content = Buffer.from("hello world");
    const hash = hashObject("blob", content);
    // git hash-object 标准值
    expect(hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));
  });

  test("相同内容产生相同哈希", () => {
    const h1 = hashObject("blob", Buffer.from("data"));
    const h2 = hashObject("blob", Buffer.from("data"));
    expect(h1).toBe(h2);
  });

  test("commit 类型哈希", () => {
    const content = Buffer.from(
      "tree 4b825dc642cb6eb9a060e54bf899d153036d1e4d\nauthor A <a@a> 0 +0000\ncommitter A <a@a> 0 +0000\n\nmsg\n",
    );
    const hash = hashObject("commit", content);
    expect(typeof hash).toBe("string");
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  test("tree 类型哈希", () => {
    const content = Buffer.from("");
    const hash = hashObject("tree", content);
    expect(typeof hash).toBe("string");
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  test("tag 类型哈希", () => {
    const content = Buffer.from(
      "object 95d09f2b10159347eece71399a7e2e907ea3df4f\ntype commit\ntag v1.0\ntagger A <a@a> 0 +0000\n\nmsg\n",
    );
    const hash = hashObject("tag", content);
    expect(typeof hash).toBe("string");
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });
});
