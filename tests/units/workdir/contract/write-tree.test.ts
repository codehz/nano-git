/**
 * VirtualWorkdir 合同测试：writeTree 持久化语义
 */
import { describe, expect, test } from "bun:test";

import { virtualWorkdirBackends } from "./contract.ts";
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

describe("VirtualWorkdir contract: writeTree", () => {
  describe.each(virtualWorkdirBackends)("$name", ({ createWorkdir }) => {
    test("重复 writeTree 结果稳定", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.writeFile("file.txt", Buffer.from("stable"));
      const hash1 = session.writeTree();
      const hash2 = session.writeTree();

      expect(hash1).toBe(hash2);
    });

    test("writeTree 后可被新 workdir 重新打开", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", Buffer.from("alpha"));
      session.mkdir("dir");
      session.writeFile("dir/b.txt", Buffer.from("beta"));

      const tree = session.writeTree();
      const reopened = createWorkdir(repo, { baseTree: tree as SHA1 });

      expect(reopened.readFile("a.txt").toString()).toBe("alpha");
      expect(reopened.readFile("dir/b.txt").toString()).toBe("beta");
    });

    test("空 workdir writeTree 返回 baseTree", () => {
      const repo = createMemoryRepository();
      const baseTree = repo.createTree([]);
      const session = createWorkdir(repo, { baseTree });

      expect(session.writeTree()).toBe(baseTree);
    });

    test("writeTree 不改变当前 session 的 baseTree", () => {
      const repo = createMemoryRepository();
      const baseTree = repo.createTree([]);
      const session = createWorkdir(repo, { baseTree });

      session.writeFile("file.txt", Buffer.from("data"));
      session.writeTree();

      expect(session.baseTree).toBe(baseTree);
      expect(session.readFile("file.txt").toString()).toBe("data");
    });

    test("writeTree 复用未修改路径的原始 blob hash", () => {
      const repo = createMemoryRepository();
      const blobHash = repo.writeBlob(Buffer.from("unchanged"));
      const baseTree = repo.createTree([{ mode: "100644", name: "old.txt", hash: blobHash }]);
      const session = createWorkdir(repo, { baseTree });

      session.writeFile("new.txt", Buffer.from("new"));
      const tree = readTree(repo, session.writeTree());
      const oldEntry = tree.entries.find((entry) => entry.name === "old.txt");

      expect(oldEntry).toBeDefined();
      expect(oldEntry?.hash).toBe(blobHash);
    });

    test("删除目录后同名写文件时 writeTree 不保留旧子树", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.mkdir("manuscript");
      session.writeFile("manuscript/a.md", Buffer.from("a"));
      session.delete("manuscript", { force: true });
      session.writeFile("manuscript", Buffer.from("file-now"));

      const root = readTree(repo, session.writeTree());
      expect(root.entries).toHaveLength(1);
      expect(root.entries[0]).toMatchObject({ mode: "100644", name: "manuscript" });
      expect(readBlob(repo, root.entries[0]!.hash).toString()).toBe("file-now");
    });
  });
});
