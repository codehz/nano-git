/**
 * VirtualWorktree 组合操作测试：writeTree 交织与哈希稳定性
 *
 * 验证连续多次 writeTree 与修改交织后结果自洽，
 * 以及不修改 baseTree 时多次 writeTree 返回相同哈希。
 */
import { describe, expect, test } from "bun:test";

import { virtualWorktreeBackends } from "./contract.ts";
import { readBlob, readTree } from "./test-utils.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorktree contract: writeTree interleave", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    test("连续多次 writeTree 与修改交织，每次结果自洽", () => {
      const repo = createMemoryRepository();
      const baseTree = repo.createTree([]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("a.txt", Buffer.from("v1"));
      session.mkdir("dir");

      const t1 = session.writeTree();
      const t1Root = readTree(repo, t1);
      expect(t1Root.entries.map((e) => e.name).sort()).toEqual(["a.txt", "dir"]);

      session.writeFile("dir/b.txt", Buffer.from("v2"));
      const t2 = session.writeTree();
      const t2Root = readTree(repo, t2);
      const t2Dir = readTree(repo, t2Root.entries.find((e) => e.name === "dir")!.hash);
      expect(t2Dir.entries.map((e) => e.name)).toEqual(["b.txt"]);

      session.delete("a.txt");
      session.writeFile("dir/b.txt", Buffer.from("v3"));
      const t3 = session.writeTree();
      const t3Root = readTree(repo, t3);
      expect(t3Root.entries.map((e) => e.name)).toEqual(["dir"]);
      const t3Dir = readTree(repo, t3Root.entries[0]!.hash);
      expect(readBlob(repo, t3Dir.entries[0]!.hash).toString()).toBe("v3");

      expect(session.diff()).toMatchObject([
        { kind: "create", path: "dir" },
        { kind: "create", path: "dir/b.txt" },
      ]);
    });

    test("writeTree 后删除路径再 writeTree，不残留已删除条目", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("stay"));
      const baseTree = repo.createTree([{ mode: "100644", name: "keep.txt", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("temp.txt", Buffer.from("temp"));
      session.writeTree();

      session.delete("temp.txt");

      const finalHash = session.writeTree();
      const finalRoot = readTree(repo, finalHash);
      expect(finalRoot.entries.map((e) => e.name)).toEqual(["keep.txt"]);
    });

    test("writeTree 后 restore 已修改路径，diff 正确收敛", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("f", Buffer.from("edited"));
      session.writeTree();

      session.restore("f");

      expect(session.diff()).toEqual([]);
      const hash = session.writeTree();
      expect(hash).toBe(baseTree);
    });

    test("不修改 baseTree 的情况下多次 writeTree 返回相同哈希", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("stable.txt", Buffer.from("content"));
      const h1 = session.writeTree();
      const h2 = session.writeTree();
      const h3 = session.writeTree();

      expect(h1).toBe(h2);
      expect(h2).toBe(h3);

      session.writeFile("stable.txt", Buffer.from("changed"));
      const h4 = session.writeTree();
      expect(h4).not.toBe(h1);

      session.writeFile("stable.txt", Buffer.from("content"));
      const h5 = session.writeTree();
      expect(h5).toBe(h1);
    });
  });
});
