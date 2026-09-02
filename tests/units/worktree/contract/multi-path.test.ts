/**
 * VirtualWorktree 组合操作测试：多路径交织与混合操作链
 *
 * 验证多个独立路径的并行操作互不干扰，
 * 以及写→删→复制→移动→写混合操作链的正确性。
 */
import { describe, expect, test } from "bun:test";

import { bytes, bytesToUtf8 } from "../../../helpers/bytes.ts";
import { virtualWorktreeBackends } from "./contract.ts";
import { readTree } from "./test-utils.ts";
import { VirtualPathNotFoundError } from "@/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorktree contract: multi-path", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    test("多个独立路径的并行操作互不干扰", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(bytes("base"));
      const baseTree = repo.createTree([
        { mode: "100644", name: "a.txt", hash: fileHash },
        { mode: "100644", name: "b.txt", hash: fileHash },
        { mode: "040000", name: "dir", hash: repo.createTree([]) },
      ]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("a.txt", bytes("a-edited"));
      session.writeFile("new.txt", bytes("new"));
      session.delete("b.txt");
      session.writeFile("dir/child.txt", bytes("child"));
      session.mkdir("extra");
      session.writeFile("extra/x.txt", bytes("x"));

      const diff = session.diff();
      expect(diff.find((e) => e.path === "a.txt")).toMatchObject({ kind: "update" });
      expect(diff.find((e) => e.path === "b.txt")).toMatchObject({ kind: "remove" });
      expect(diff.find((e) => e.path === "new.txt")).toMatchObject({ kind: "create" });
      expect(diff.find((e) => e.path === "dir/child.txt")).toMatchObject({ kind: "create" });
      expect(diff.find((e) => e.path === "extra/x.txt")).toMatchObject({ kind: "create" });

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const entryNames = root.entries.map((e) => e.name).sort();
      expect(entryNames).toEqual(["a.txt", "dir", "extra", "new.txt"]);
    });

    test("基线目录中新增与删除交织，overlay 不出现同名冲突", () => {
      const repo = createMemoryRepository();
      const subTree = repo.createTree([
        { mode: "100644", name: "keep.txt", hash: repo.writeBlob(bytes("keep")) },
      ]);
      const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: subTree }]);
      const session = createWorktree(repo, { baseTree });

      session.delete("dir/keep.txt");
      session.writeFile("dir/keep.txt", bytes("overwrite"));
      session.delete("dir/keep.txt");
      session.writeFile("dir/keep.txt", bytes("final"));

      expect(bytesToUtf8(session.readFile("dir/keep.txt"))).toBe("final");
      expect(session.diff()[0]).toMatchObject({
        kind: "update",
        path: "dir/keep.txt",
      });
    });

    test("写→删→复制→移动→写混合操作链后 writeTree 正确", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", bytes("a"));
      session.writeFile("b.txt", bytes("b"));
      session.mkdir("sub");
      session.writeFile("sub/x.txt", bytes("x"));

      session.delete("b.txt");
      session.copy("sub", "sub2");
      session.move("a.txt", "sub/a.txt");
      session.writeFile("sub2/y.txt", bytes("y"));
      session.delete("sub/x.txt");

      expect(bytesToUtf8(session.readFile("sub/a.txt"))).toBe("a");
      expect(() => session.readFile("sub/x.txt")).toThrow(VirtualPathNotFoundError);
      expect(bytesToUtf8(session.readFile("sub2/x.txt"))).toBe("x");
      expect(bytesToUtf8(session.readFile("sub2/y.txt"))).toBe("y");
      expect(session.exists("b.txt")).toBe(false);
      expect(session.exists("a.txt")).toBe(false);

      const rootHash = session.writeTree();
      const root = readTree(repo, rootHash);
      const names = root.entries.map((e) => e.name).sort();
      expect(names).toEqual(["sub", "sub2"]);

      const sub = readTree(repo, root.entries.find((e) => e.name === "sub")!.hash);
      expect(sub.entries.map((e) => e.name)).toEqual(["a.txt"]);

      const sub2 = readTree(repo, root.entries.find((e) => e.name === "sub2")!.hash);
      expect(sub2.entries.map((e) => e.name).sort()).toEqual(["x.txt", "y.txt"]);
    });
  });
});
