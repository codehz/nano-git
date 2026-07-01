/**
 * VirtualWorktree 合同测试：持久化 worktree 重新打开语义
 */
import { describe, expect, test } from "bun:test";

import { persistentVirtualWorktreeBackends } from "./contract.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { resetNodeIdCounterForTests } from "@/worktree/model/ids.ts";

describe("VirtualWorktree contract: reopen", () => {
  describe.each(persistentVirtualWorktreeBackends)("$name", ({ createPersistentWorktree }) => {
    test("重新打开后保留未提交的 overlay 与 diff", () => {
      const repo = createMemoryRepository();
      const trackedHash = repo.writeBlob(Buffer.from("tracked-base"));
      const nestedHash = repo.writeBlob(Buffer.from("nested-base"));
      const dirTree = repo.createTree([{ mode: "100644", name: "keep.txt", hash: nestedHash }]);
      const baseTree = repo.createTree([
        { mode: "100644", name: "tracked.txt", hash: trackedHash },
        { mode: "040000", name: "dir", hash: dirTree },
      ]);
      const { worktree, reopen } = createPersistentWorktree(repo, { baseTree });

      worktree.writeFile("tracked.txt", Buffer.from("tracked-edited"));
      worktree.writeFile("fresh.txt", Buffer.from("fresh"));
      worktree.delete("dir");

      const reopened = reopen();
      expect(reopened.baseTree).toBe(baseTree);
      expect(reopened.readFile("tracked.txt").toString()).toBe("tracked-edited");
      expect(reopened.readFile("fresh.txt").toString()).toBe("fresh");
      expect(reopened.exists("dir")).toBe(false);
      const diff = reopened.diff();
      expect(diff.find((entry) => entry.path === "dir")).toMatchObject({
        kind: "remove",
        path: "dir",
        previous: { kind: "tree", mode: "040000" },
      });
      expect(diff.find((entry) => entry.path === "dir/keep.txt")).toMatchObject({
        kind: "remove",
        path: "dir/keep.txt",
        previous: { kind: "blob", mode: "100644" },
      });
      expect(diff.find((entry) => entry.path === "fresh.txt")).toMatchObject({
        kind: "create",
        path: "fresh.txt",
        current: { kind: "blob", mode: "100644" },
      });
      expect(diff.find((entry) => entry.path === "tracked.txt")).toMatchObject({
        kind: "update",
        path: "tracked.txt",
        previous: { kind: "blob", mode: "100644" },
        current: { kind: "blob", mode: "100644" },
        changes: {
          kindChanged: false,
          modeChanged: false,
          contentChanged: true,
        },
      });
    });

    test("复杂 move 后重新打开仍保留源路径复用结构", () => {
      const repo = createMemoryRepository();
      const { worktree, reopen } = createPersistentWorktree(repo, {
        baseTree: repo.createTree([]),
      });

      worktree.writeFile("a.txt", Buffer.from("moved"));
      worktree.move("a.txt", "deep/nested/b.txt");
      worktree.mkdir("a.txt");
      worktree.writeFile("a.txt/c.txt", Buffer.from("child"));

      const reopened = reopen();
      expect(reopened.readFile("deep/nested/b.txt").toString()).toBe("moved");
      expect(reopened.readFile("a.txt/c.txt").toString()).toBe("child");
      expect(
        reopened
          .readdir()
          .map((entry) => entry.name)
          .sort(),
      ).toEqual(["a.txt", "deep"]);
    });

    test("重新打开后继续向既有目录写入不会触发父目录类型错乱", () => {
      resetNodeIdCounterForTests(1);
      const repo = createMemoryRepository();
      const { worktree, reopen } = createPersistentWorktree(repo, {
        baseTree: repo.createTree([]),
      });

      worktree.mkdir("a");

      resetNodeIdCounterForTests(1);
      const reopened = reopen();
      expect(() => reopened.writeFile("a/x.txt", Buffer.from("x"))).not.toThrow();
      expect(reopened.readFile("a/x.txt").toString()).toBe("x");
    });

    test("重新打开后新建同级节点不会覆盖未访问的深层持久化节点", () => {
      resetNodeIdCounterForTests(1);
      const repo = createMemoryRepository();
      const { worktree, reopen } = createPersistentWorktree(repo, {
        baseTree: repo.createTree([]),
      });

      worktree.mkdir("a");
      worktree.writeFile("a/b.txt", Buffer.from("nested"));

      resetNodeIdCounterForTests(1);
      const reopened = reopen();
      reopened.writeFile("c.txt", Buffer.from("root"));

      expect(reopened.readFile("a/b.txt").toString()).toBe("nested");
      expect(reopened.readFile("c.txt").toString()).toBe("root");
    });

    test("writeTree 后重新打开仍保留当前 overlay，且 baseTree 不变", () => {
      const repo = createMemoryRepository();
      const baseTree = repo.createTree([]);
      const { worktree, reopen } = createPersistentWorktree(repo, { baseTree });

      worktree.writeFile("file.txt", Buffer.from("data"));
      const writtenTree = worktree.writeTree();

      expect(writtenTree).not.toBe(baseTree);

      const reopened = reopen();
      expect(reopened.baseTree).toBe(baseTree);
      expect(reopened.readFile("file.txt").toString()).toBe("data");
      expect(reopened.diff()).toMatchObject([
        {
          kind: "create",
          path: "file.txt",
          current: { kind: "blob", mode: "100644" },
        },
      ]);
    });

    test("reset 后重新打开反映新基线并清空旧 overlay", () => {
      const repo = createMemoryRepository();
      const afterHash = repo.writeBlob(Buffer.from("after"));
      const nextTree = repo.createTree([{ mode: "100644", name: "after.txt", hash: afterHash }]);
      const { worktree, reopen } = createPersistentWorktree(repo, {
        baseTree: repo.createTree([]),
      });

      worktree.writeFile("before.txt", Buffer.from("before"));
      worktree.reset(nextTree);

      const reopened = reopen();
      expect(reopened.baseTree).toBe(nextTree);
      expect(reopened.exists("before.txt")).toBe(false);
      expect(reopened.readFile("after.txt").toString()).toBe("after");
      expect(reopened.diff()).toEqual([]);
    });
  });
});
