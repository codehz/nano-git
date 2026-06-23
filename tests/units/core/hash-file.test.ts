/**
 * core/hash-file.ts 单元测试
 *
 * 测试 hashFile 函数（将文件作为 blob 计算 SHA-1）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashFile } from "@/core/hash-file.ts";
import { sha1 } from "@/core/types.ts";

describe("hashFile()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-hashfile-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("计算文件的 blob SHA-1 哈希", () => {
    const filePath = join(tempDir, "hello.txt");
    writeFileSync(filePath, "hello world");

    // "blob 11\0hello world" 的 SHA-1
    const hash = hashFile(filePath);
    expect(hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));
  });

  test("空文件的哈希", () => {
    const filePath = join(tempDir, "empty.txt");
    writeFileSync(filePath, "");

    // "blob 0\0" 的 SHA-1
    const hash = hashFile(filePath);
    expect(hash).toBe(sha1("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"));
  });

  test("相同内容的文件产生相同哈希", () => {
    const a = join(tempDir, "a.txt");
    const b = join(tempDir, "b.txt");
    writeFileSync(a, "same content");
    writeFileSync(b, "same content");

    expect(hashFile(a)).toBe(hashFile(b));
  });

  test("不同内容的文件产生不同哈希", () => {
    const a = join(tempDir, "a.txt");
    const b = join(tempDir, "b.txt");
    writeFileSync(a, "content a");
    writeFileSync(b, "content b");

    expect(hashFile(a)).not.toBe(hashFile(b));
  });
});
