/**
 * VirtualWorktree 组合操作测试：restore 后修改与深层 restore
 *
 * 验证 restore 操作后的修改能正确更新 diff，
 * 以及 restore 递归/非递归行为的一致性。
 */
import { describe, expect, test } from "bun:test";

import { virtualWorktreeBackends } from "./contract.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorktree contract: restore combinations", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    test("restore 递归后立即修改能正确更新 diff", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const dirTree = repo.createTree([{ mode: "100644", name: "f.txt", hash: fileHash }]);
      const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: dirTree }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("dir/f.txt", Buffer.from("edited"));
      session.restore("dir", { recursive: true });

      expect(session.diff()).toEqual([]);

      session.writeFile("dir/f.txt", Buffer.from("re-edited"));

      expect(session.diff()).toMatchObject([{ kind: "update", path: "dir/f.txt" }]);
    });

    test("restore 为非递归目录后，子树中写文件仍可读", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const dirTree = repo.createTree([
        { mode: "100644", name: "a.txt", hash: fileHash },
        { mode: "100644", name: "b.txt", hash: fileHash },
      ]);
      const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: dirTree }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("dir/a.txt", Buffer.from("edited-a"));
      session.delete("dir/b.txt");
      session.restore("dir");

      expect(session.readFile("dir/a.txt").toString()).toBe("edited-a");
      expect(session.exists("dir/b.txt")).toBe(false);

      session.writeFile("dir/c.txt", Buffer.from("new-c"));

      expect(session.readFile("dir/c.txt").toString()).toBe("new-c");
    });

    test("restore 文件前先删除父目录，restore 自动重建目录链", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("deep-base"));
      const inner = repo.createTree([{ mode: "100644", name: "target.txt", hash: fileHash }]);
      const outer = repo.createTree([{ mode: "040000", name: "inner", hash: inner }]);
      const baseTree = repo.createTree([{ mode: "040000", name: "outer", hash: outer }]);
      const session = createWorktree(repo, { baseTree });

      session.delete("outer");
      expect(session.exists("outer")).toBe(false);

      session.restore("outer/inner/target.txt", { recursive: true });

      expect(session.readFile("outer/inner/target.txt").toString()).toBe("deep-base");
      expect(session.diff()).toEqual([]);
    });

    test("restore 递归后将子树中新增文件标记为删除，diff 正确", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const dirTree = repo.createTree([{ mode: "100644", name: "f.txt", hash: fileHash }]);
      const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: dirTree }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("dir/new.txt", Buffer.from("new"));
      session.restore("dir", { recursive: true });

      expect(session.exists("dir/new.txt")).toBe(false);
      expect(session.diff()).toEqual([]);
    });
  });
});
