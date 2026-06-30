/**
 * VirtualWorktree 合同测试：writeTree 持久化语义
 */
import { describe, expect, test } from "bun:test";

import { virtualWorktreeBackends } from "./contract.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

import type { GitTree, SHA1 } from "@/core/types.ts";

/** 读取 tree 对象（类型断言辅助） */
function readTree(repo: ReturnType<typeof createMemoryRepository>, hash: string): GitTree {
  const obj = repo.catFile(hash as SHA1);
  if (obj.type !== "tree") throw new Error(`Expected tree, got ${obj.type}`);
  return obj;
}

/** 读取 blob 内容（类型断言辅助） */
function readBlob(repo: ReturnType<typeof createMemoryRepository>, hash: string): Buffer {
  const obj = repo.catFile(hash as SHA1);
  if (obj.type !== "blob") throw new Error(`Expected blob, got ${obj.type}`);
  return obj.content;
}

describe("VirtualWorktree contract: writeTree", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    test("重复 writeTree 结果稳定", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("file.txt", Buffer.from("stable"));
      const hash1 = session.writeTree();
      const hash2 = session.writeTree();

      expect(hash1).toBe(hash2);
    });

    test("writeTree 后可被新 worktree 重新打开", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", Buffer.from("alpha"));
      session.mkdir("dir");
      session.writeFile("dir/b.txt", Buffer.from("beta"));

      const tree = session.writeTree();
      const reopened = createWorktree(repo, { baseTree: tree as SHA1 });

      expect(reopened.readFile("a.txt").toString()).toBe("alpha");
      expect(reopened.readFile("dir/b.txt").toString()).toBe("beta");
    });

    test("空 worktree writeTree 返回 baseTree", () => {
      const repo = createMemoryRepository();
      const baseTree = repo.createTree([]);
      const session = createWorktree(repo, { baseTree });

      expect(session.writeTree()).toBe(baseTree);
    });

    test("writeTree 不改变当前 session 的 baseTree", () => {
      const repo = createMemoryRepository();
      const baseTree = repo.createTree([]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("file.txt", Buffer.from("data"));
      session.writeTree();

      expect(session.baseTree).toBe(baseTree);
      expect(session.readFile("file.txt").toString()).toBe("data");
    });

    test("writeTree 复用未修改路径的原始 blob hash", () => {
      const repo = createMemoryRepository();
      const blobHash = repo.writeBlob(Buffer.from("unchanged"));
      const baseTree = repo.createTree([{ mode: "100644", name: "old.txt", hash: blobHash }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("new.txt", Buffer.from("new"));
      const tree = readTree(repo, session.writeTree());
      const oldEntry = tree.entries.find((entry) => entry.name === "old.txt");

      expect(oldEntry).toBeDefined();
      expect(oldEntry?.hash).toBe(blobHash);
    });

    test("删除目录后同名写文件时 writeTree 不保留旧子树", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("manuscript");
      session.writeFile("manuscript/a.md", Buffer.from("a"));
      session.delete("manuscript", { force: true });
      session.writeFile("manuscript", Buffer.from("file-now"));

      const root = readTree(repo, session.writeTree());
      expect(root.entries).toHaveLength(1);
      expect(root.entries[0]).toMatchObject({ mode: "100644", name: "manuscript" });
      expect(readBlob(repo, root.entries[0]!.hash).toString()).toBe("file-now");
    });

    // ====== 以下测试由单后端 worktree-write-tree / worktree-reset 转换而来 ======

    test("新建单文件后 writeTree", () => {
      const repo = createMemoryRepository();
      const baseTree = repo.createTree([]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("a.txt", Buffer.from("hello"));
      const newTree = session.writeTree();
      expect(newTree).not.toBe(baseTree);

      const tree = readTree(repo, newTree);
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("a.txt");
      expect(tree.entries[0]!.mode).toBe("100644");

      const blob = readBlob(repo, tree.entries[0]!.hash);
      expect(blob.toString()).toBe("hello");
    });

    test("writeTree 不破坏 overlay，新建文件后可继续读取", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("f.txt", Buffer.from("data"));
      session.writeTree();
      expect(session.readFile("f.txt").toString()).toBe("data");
    });

    test("嵌套目录+多文件 writeTree", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.writeFile("src/main.ts", Buffer.from("console.log(1)"));
      session.writeFile("src/lib.ts", Buffer.from("export {}"));
      session.writeFile("README.md", Buffer.from("# Project"));

      const newTree = session.writeTree();
      const tree = readTree(repo, newTree);
      expect(tree.entries).toHaveLength(2);
      const names = tree.entries.map((e) => e.name).sort();
      expect(names).toEqual(["README.md", "src"]);

      const srcEntry = tree.entries.find((e) => e.name === "src")!;
      expect(srcEntry.mode).toBe("040000");
      const srcTree = readTree(repo, srcEntry.hash);
      const srcNames = srcTree.entries.map((e) => e.name).sort();
      expect(srcNames).toEqual(["lib.ts", "main.ts"]);
    });

    test("多次写入后 writeTree 产出正确的 tree 结构", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.writeFile("src/a.ts", Buffer.from("a1"));
      session.writeFile("src/b.ts", Buffer.from("b1"));
      session.writeFile("src/a.ts", Buffer.from("a2"));

      const treeHash = session.writeTree();
      const root = readTree(repo, treeHash);
      expect(root.entries).toHaveLength(1);
      expect(root.entries[0]?.name).toBe("src");
      const src = readTree(repo, root.entries[0]!.hash);
      expect(src.entries).toHaveLength(2);
      const aEntry = src.entries.find((e) => e.name === "a.ts");
      const bEntry = src.entries.find((e) => e.name === "b.ts");
      expect(aEntry).toBeDefined();
      expect(bEntry).toBeDefined();
    });
  });
});
