/**
 * VirtualWorktree 合同测试：状态收敛与基线恢复语义
 */
import { describe, expect, test } from "bun:test";

import { virtualWorktreeBackends } from "./contract.ts";
import { VirtualPathNotFoundError } from "@/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorktree contract: state", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    test("restore 可恢复到基线内容", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const baseTree = repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("file.txt", Buffer.from("edited"));
      session.restore("file.txt");

      expect(session.readFile("file.txt").toString()).toBe("base");
      expect(session.diff()).toEqual([]);
    });

    test("restore 可恢复被删除的 repo-backed 路径", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const baseTree = repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      session.delete("file.txt");
      session.restore("file.txt");

      expect(session.readFile("file.txt").toString()).toBe("base");
      expect(session.diff()).toEqual([]);
    });

    test("目录 restore 默认不递归恢复子树修改", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const dirTree = repo.createTree([{ mode: "100644", name: "nested.txt", hash: fileHash }]);
      const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: dirTree }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("dir/nested.txt", Buffer.from("edited"));
      session.restore("dir");

      expect(session.readFile("dir/nested.txt").toString()).toBe("edited");
    });

    test("recursive restore 会恢复目录子树修改", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const dirTree = repo.createTree([{ mode: "100644", name: "nested.txt", hash: fileHash }]);
      const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: dirTree }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("dir/nested.txt", Buffer.from("edited"));
      session.restore("dir", { recursive: true });

      expect(session.readFile("dir/nested.txt").toString()).toBe("base");
      expect(session.diff()).toEqual([]);
    });

    test("restore 基线不存在路径且未启用 force 时抛 VirtualPathNotFoundError", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("temp.txt", Buffer.from("temp"));

      expect(() => session.restore("temp.txt")).toThrow(VirtualPathNotFoundError);
      expect(session.readFile("temp.txt").toString()).toBe("temp");
    });

    test("restore 基线不存在路径且启用 force 时等价删除", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("dir");
      session.writeFile("dir/temp.txt", Buffer.from("temp"));
      session.restore("dir", { force: true });

      expect(session.exists("dir")).toBe(false);
      expect(session.diff()).toEqual([]);
    });

    test("restore 会按基线重建祖先目录链", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const nestedTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: fileHash }]);
      const parentTree = repo.createTree([{ mode: "040000", name: "nested", hash: nestedTree }]);
      const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: parentTree }]);
      const session = createWorktree(repo, { baseTree });

      session.delete("src");
      session.writeFile("src", Buffer.from("blocking file"));
      session.restore("src/nested/a.txt", { recursive: true });

      expect(session.stat("src")).toMatchObject({ kind: "tree", mode: "040000" });
      expect(session.readFile("src/nested/a.txt").toString()).toBe("base");
      expect(session.diff()).toEqual([]);
    });

    test("重复 diff 结果稳定", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const baseTree = repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("file.txt", Buffer.from("edited"));
      session.writeFile("fresh.txt", Buffer.from("new"));

      const diff1 = session.diff();
      const diff2 = session.diff();

      expect(diff2).toEqual(diff1);
    });

    test("diff 正确表示 create / update / remove / kindChanged", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("old"));
      const dirTree = repo.createTree([]);
      const baseTree = repo.createTree([
        { mode: "100644", name: "file.txt", hash: fileHash },
        { mode: "040000", name: "dir", hash: dirTree },
      ]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("fresh.txt", Buffer.from("fresh"));
      session.writeFile("file.txt", Buffer.from("new"));
      session.delete("dir");

      const diff = session.diff();
      expect(diff.find((entry) => entry.path === "fresh.txt")).toMatchObject({
        kind: "create",
        path: "fresh.txt",
        current: { kind: "blob", mode: "100644" },
      });
      expect(diff.find((entry) => entry.path === "file.txt")).toMatchObject({
        kind: "update",
        path: "file.txt",
        previous: { kind: "blob", mode: "100644" },
        current: { kind: "blob", mode: "100644" },
        changes: {
          kindChanged: false,
          modeChanged: false,
          contentChanged: true,
        },
      });
      expect(diff.find((entry) => entry.path === "dir")).toMatchObject({
        kind: "remove",
        path: "dir",
        previous: { kind: "tree", mode: "040000" },
      });
    });

    test("diff 在文件与符号链接互换时标记 kindChanged", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("data"));
      const session = createWorktree(repo, {
        baseTree: repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]),
      });

      session.writeLink("file.txt", "target");

      expect(session.diff()).toMatchObject([
        {
          kind: "update",
          path: "file.txt",
          previous: { kind: "blob", mode: "100644" },
          current: { kind: "symlink", mode: "120000" },
          changes: {
            kindChanged: true,
            modeChanged: true,
            contentChanged: true,
          },
        },
      ]);
    });

    test("reset 丢弃 overlay", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("after"));
      const nextTree = repo.createTree([{ mode: "100644", name: "after.txt", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("before.txt", Buffer.from("before"));
      session.reset(nextTree);

      expect(session.exists("before.txt")).toBe(false);
      expect(session.readFile("after.txt").toString()).toBe("after");
      expect(session.diff()).toEqual([]);
    });

    test("新增后再删除时 diff 正确收敛到剩余目录创建", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.writeFile("src/a.ts", Buffer.from("a1"));
      session.delete("src/a.ts");

      expect(session.diff()).toMatchObject([
        {
          kind: "create",
          path: "src",
          current: {
            kind: "tree",
            mode: "040000",
          },
        },
      ]);
    });

    // ====== 以下测试由单后端 worktree-reset 转换而来 ======

    test("reset 后行为等同新 worktree", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("base"));
      const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("temp.txt", Buffer.from("temp"));
      session.reset(baseTree);

      const fresh = createWorktree(repo, { baseTree });
      expect(session.readdir()).toEqual(fresh.readdir());
      expect(session.readFile("f").toString()).toBe(fresh.readFile("f").toString());
    });
  });
});
