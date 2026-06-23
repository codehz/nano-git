/**
 * refs/fs-utils.ts 单元测试
 *
 * 测试文件系统 Refs 辅助函数
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listLooseRefsRecursive } from "@/refs/fs-utils.ts";

describe("listLooseRefsRecursive()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-refs-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("空目录返回空数组", () => {
    const refs = listLooseRefsRecursive(tempDir, "refs/");
    expect(refs).toEqual([]);
  });

  test("列出单层引用文件", () => {
    writeFileSync(join(tempDir, "heads"), "content");
    writeFileSync(join(tempDir, "tags"), "content");

    const refs = listLooseRefsRecursive(tempDir, "refs/");
    expect(refs.sort()).toEqual(["refs/heads", "refs/tags"]);
  });

  test("递归遍历子目录", () => {
    mkdirSync(join(tempDir, "heads"), { recursive: true });
    mkdirSync(join(tempDir, "tags"), { recursive: true });
    writeFileSync(join(tempDir, "heads", "main"), "hash1\n");
    writeFileSync(join(tempDir, "heads", "feature"), "hash2\n");
    writeFileSync(join(tempDir, "tags", "v1.0"), "hash3\n");

    const refs = listLooseRefsRecursive(tempDir, "refs/");
    expect(refs.sort()).toEqual(["refs/heads/feature", "refs/heads/main", "refs/tags/v1.0"]);
  });

  test("跳过非文件条目（如目录本身）", () => {
    mkdirSync(join(tempDir, "heads"), { recursive: true });
    writeFileSync(join(tempDir, "heads", "main"), "hash\n");
    // 在 heads 下创建一个子目录，应该被跳过（不是文件）
    mkdirSync(join(tempDir, "heads", "sub"), { recursive: true });

    const refs = listLooseRefsRecursive(tempDir, "refs/");
    expect(refs).toEqual(["refs/heads/main"]);
  });

  test("嵌套深层目录结构", () => {
    mkdirSync(join(tempDir, "remotes", "origin"), { recursive: true });
    writeFileSync(join(tempDir, "remotes", "origin", "main"), "hash\n");
    writeFileSync(join(tempDir, "remotes", "origin", "feature"), "hash\n");

    const refs = listLooseRefsRecursive(tempDir, "refs/");
    expect(refs.sort()).toEqual(["refs/remotes/origin/feature", "refs/remotes/origin/main"]);
  });

  test("prefix 参数影响返回的 ref 名称", () => {
    mkdirSync(join(tempDir, "heads"), { recursive: true });
    writeFileSync(join(tempDir, "heads", "main"), "hash\n");

    const refs = listLooseRefsRecursive(tempDir, "");
    expect(refs).toEqual(["heads/main"]);
  });
});
