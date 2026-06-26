/**
 * workdir/workdir.ts writeTree 操作单元测试
 */
import { describe, test, expect } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdir } from "@/workdir/workdir.ts";

import type { GitTree } from "@/core/types.ts";
import type { Repository } from "@/repository/types.ts";

/** 读取 tree 对象（类型断言辅助） */
function readTree(repo: Repository, hash: string): GitTree {
  const obj = repo.catFile(hash as import("@/core/types.ts").SHA1);
  if (obj.type !== "tree") throw new Error(`Expected tree, got ${obj.type}`);
  return obj;
}

/** 读取 blob 内容（类型断言辅助） */
function readBlob(repo: Repository, hash: string): Buffer {
  const obj = repo.catFile(hash as import("@/core/types.ts").SHA1);
  if (obj.type !== "blob") throw new Error(`Expected blob, got ${obj.type}`);
  return obj.content;
}

describe("writeTree", () => {
  test("空 workdir writeTree 返回 baseTree", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    expect(session.writeTree()).toBe(baseTree);
  });

  test("新建单文件后 writeTree", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("a.txt", Buffer.from("hello"));
    const newTree = session.writeTree();
    expect(newTree).not.toBe(baseTree);

    // 用 repo 读取导出的 tree 验证内容
    const tree = readTree(repo, newTree);
    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]!.name).toBe("a.txt");
    expect(tree.entries[0]!.mode).toBe("100644");

    const blob = readBlob(repo, tree.entries[0]!.hash);
    expect(blob.toString()).toBe("hello");
  });

  test("新建文件后可继续读取", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("f.txt", Buffer.from("data"));
    session.writeTree();
    // 继续读取（overlay 未清空）
    expect(session.readFile("f.txt").toString()).toBe("data");
  });

  test("连续多次 writeTree 结果可重复", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("f.txt", Buffer.from("stable"));
    const hash1 = session.writeTree();
    const hash2 = session.writeTree();
    expect(hash1).toBe(hash2);
  });

  test("未修改路径的 blob hash 保持稳定复用", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("unchanged"));
    const baseTree = repo.createTree([{ mode: "100644", name: "old.txt", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    // 只新增一个文件，不动 old.txt
    session.writeFile("new.txt", Buffer.from("new"));
    const newTree = session.writeTree();

    const tree = readTree(repo, newTree);
    const oldEntry = tree.entries.find((e) => e.name === "old.txt");
    expect(oldEntry).toBeDefined();
    // old.txt 应复用原 blob
    expect(oldEntry!.hash).toBe(blobHash);
  });

  test("嵌套目录+多文件 writeTree", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("src");
    session.writeFile("src/main.ts", Buffer.from("console.log(1)"));
    session.writeFile("src/lib.ts", Buffer.from("export {}"));
    session.writeFile("README.md", Buffer.from("# Project"));

    const newTree = session.writeTree();
    const tree = readTree(repo, newTree);
    expect(tree.entries).toHaveLength(2); // src + README.md
    const names = tree.entries.map((e) => e.name).sort();
    expect(names).toEqual(["README.md", "src"]);

    // 读取 src 子树
    const srcEntry = tree.entries.find((e) => e.name === "src")!;
    expect(srcEntry.mode).toBe("040000");
    const srcTree = readTree(repo, srcEntry.hash);
    const srcNames = srcTree.entries.map((e) => e.name).sort();
    expect(srcNames).toEqual(["lib.ts", "main.ts"]);
  });

  test("writeTree 后 baseTree 不变", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("f.txt", Buffer.from("data"));
    session.writeTree();
    expect(session.baseTree).toBe(baseTree);
  });

  test("新建空目录后 writeTree", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("empty");
    const newTree = session.writeTree();
    const tree = readTree(repo, newTree);
    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]!.name).toBe("empty");
    expect(tree.entries[0]!.mode).toBe("040000");
  });

  test("writeTree 后通过新 workdir 读取验证", () => {
    const repo = createMemoryRepository();
    const session1 = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session1.writeFile("a.txt", Buffer.from("alpha"));
    session1.writeFile("b.txt", Buffer.from("beta"));
    const hash = session1.writeTree();

    // 用新的 workdir 打开导出 tree
    const session2 = createVirtualWorkdir(repo.objects, { baseTree: hash });
    expect(session2.readdir().length).toBe(2);
    expect(session2.readFile("a.txt").toString()).toBe("alpha");
    expect(session2.readFile("b.txt").toString()).toBe("beta");
  });
});
