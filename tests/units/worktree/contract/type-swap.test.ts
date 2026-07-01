/**
 * VirtualWorktree 组合操作测试：文件-目录类型互换
 *
 * 验证文件与目录在同一路径反复切换时，writeTree 不残留旧子树。
 */
import { describe, expect, test } from "bun:test";

import { virtualWorktreeBackends } from "./contract.ts";
import { readBlob, readTree } from "./test-utils.ts";
import { VirtualPathNotFoundError } from "@/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorktree contract: type swap", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    test("基线的目录被删除后创建为同名文件，writeTree 不残留旧子树", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("alpha"));
      const subTree = repo.createTree([{ mode: "100644", name: "nested.txt", hash: fileHash }]);
      const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: subTree }]);
      const session = createWorktree(repo, { baseTree });

      session.delete("dir");
      session.writeFile("dir", Buffer.from("file-now"));

      expect(session.stat("dir")).toMatchObject({ kind: "blob", mode: "100644" });
      expect(() => session.readFile("dir/nested.txt")).toThrow(VirtualPathNotFoundError);

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      expect(root.entries).toHaveLength(1);
      expect(root.entries[0]!).toMatchObject({ mode: "100644", name: "dir" });
      expect(readBlob(repo, root.entries[0]!.hash).toString()).toBe("file-now");
    });

    test("基线的文件被删除后创建为同名目录，writeTree 后目录可含子文件", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("content"));
      const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      session.delete("f");
      session.mkdir("f");
      session.writeFile("f/child.txt", Buffer.from("child"));

      expect(session.stat("f")).toMatchObject({ kind: "tree", mode: "040000" });
      expect(session.readFile("f/child.txt").toString()).toBe("child");

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      expect(root.entries).toHaveLength(1);
      expect(root.entries[0]!).toMatchObject({ mode: "040000", name: "f" });
      const dir = readTree(repo, root.entries[0]!.hash);
      expect(dir.entries).toHaveLength(1);
      expect(dir.entries[0]!).toMatchObject({ mode: "100644", name: "child.txt" });
    });

    test("文件→目录→文件往返 writeTree 三次结果均正确", () => {
      const repo = createMemoryRepository();
      const baseTree = repo.createTree([]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("x", Buffer.from("v1"));
      const t1 = session.writeTree();
      expect(readBlob(repo, readTree(repo, t1).entries[0]!.hash).toString()).toBe("v1");

      session.delete("x");
      session.mkdir("x");
      session.writeFile("x/y.txt", Buffer.from("v2"));
      const t2 = session.writeTree();
      const t2Root = readTree(repo, t2);
      expect(t2Root.entries[0]!).toMatchObject({ mode: "040000", name: "x" });
      expect(
        readBlob(repo, readTree(repo, t2Root.entries[0]!.hash).entries[0]!.hash).toString(),
      ).toBe("v2");

      session.delete("x");
      session.writeFile("x", Buffer.from("v3"));
      const t3 = session.writeTree();
      expect(readBlob(repo, readTree(repo, t3).entries[0]!.hash).toString()).toBe("v3");
    });
  });
});
