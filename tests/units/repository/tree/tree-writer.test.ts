/**
 * repository/tree/tree-writer.ts 单元测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readObject } from "@/objects/raw.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";
import { writeTreeRecursive } from "@/repository/tree/tree-writer.ts";

describe("writeTreeRecursive()", () => {
  let tempDir: string;
  let store: ReturnType<typeof createMemoryObjectStore>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-tree-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
    store = createMemoryObjectStore();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("空目录写入空 tree", () => {
    const hash = writeTreeRecursive(store, tempDir);
    const tree = readObject(store, hash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(0);
    }
  });

  test("单个文件写入 tree", () => {
    writeFileSync(join(tempDir, "hello.txt"), "hello world");
    const hash = writeTreeRecursive(store, tempDir);

    const tree = readObject(store, hash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("hello.txt");
      expect(tree.entries[0]!.mode).toBe("100644");
    }
  });

  test("多文件按名称排序", () => {
    writeFileSync(join(tempDir, "b.txt"), "b");
    writeFileSync(join(tempDir, "a.txt"), "a");
    writeFileSync(join(tempDir, "c.txt"), "c");

    const hash = writeTreeRecursive(store, tempDir);
    const tree = readObject(store, hash);
    if (tree.type === "tree") {
      expect(tree.entries.map((e) => e.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
    }
  });

  test("递归处理子目录", () => {
    writeFileSync(join(tempDir, "root.txt"), "root");
    mkdirSync(join(tempDir, "subdir"));
    writeFileSync(join(tempDir, "subdir", "inner.txt"), "inner");

    const hash = writeTreeRecursive(store, tempDir);
    const tree = readObject(store, hash);
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(2);
      const subdir = tree.entries.find((e) => e.name === "subdir");
      expect(subdir).toBeDefined();
      expect(subdir!.mode).toBe("040000");

      // 验证子 tree 内容
      const subTree = readObject(store, subdir!.hash);
      expect(subTree.type).toBe("tree");
      if (subTree.type === "tree") {
        expect(subTree.entries).toHaveLength(1);
        expect(subTree.entries[0]!.name).toBe("inner.txt");
      }
    }
  });

  test("跳过 .git 目录", () => {
    writeFileSync(join(tempDir, "f.txt"), "f");
    mkdirSync(join(tempDir, ".git"));
    writeFileSync(join(tempDir, ".git", "config"), "config");

    const hash = writeTreeRecursive(store, tempDir);
    const tree = readObject(store, hash);
    if (tree.type === "tree") {
      const names = tree.entries.map((e) => e.name);
      expect(names).not.toContain(".git");
      expect(names).toEqual(["f.txt"]);
    }
  });

  test("符号链接写入 mode 120000", () => {
    writeFileSync(join(tempDir, "target.txt"), "target content");
    symlinkSync("target.txt", join(tempDir, "link.txt"));

    const hash = writeTreeRecursive(store, tempDir);
    const tree = readObject(store, hash);
    if (tree.type === "tree") {
      const link = tree.entries.find((e) => e.name === "link.txt");
      expect(link).toBeDefined();
      expect(link!.mode).toBe("120000");

      // 验证符号链接指向的内容作为 blob 存储
      const linkBlob = readObject(store, link!.hash);
      expect(linkBlob.type).toBe("blob");
      if (linkBlob.type === "blob") {
        expect(linkBlob.content.toString()).toBe("target.txt");
      }
    }
  });

  test("可执行文件写入 mode 100755", () => {
    writeFileSync(join(tempDir, "script.sh"), "#!/bin/sh\necho hi", { mode: 0o755 });

    const hash = writeTreeRecursive(store, tempDir);
    const tree = readObject(store, hash);
    if (tree.type === "tree") {
      const script = tree.entries.find((e) => e.name === "script.sh");
      expect(script).toBeDefined();
      // Bun on Linux 会保留可执行权限
      expect(script!.mode).toBe("100755");
    }
  });
});
