/**
 * VirtualWorktree 合同测试：持久化 worktree 重新打开语义
 */
import { describe, expect, test } from "bun:test";

import { bytes, bytesToUtf8 } from "../../../helpers/bytes.ts";
import { persistentVirtualWorktreeBackends } from "./contract.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorktree contract: reopen", () => {
  describe.each(persistentVirtualWorktreeBackends)("$name", ({ createPersistentWorktree }) => {
    test("重新打开后保留未提交的 overlay 与 diff", () => {
      const repo = createMemoryRepository();
      const trackedHash = repo.writeBlob(bytes("tracked-base"));
      const nestedHash = repo.writeBlob(bytes("nested-base"));
      const dirTree = repo.createTree([{ mode: "100644", name: "keep.txt", hash: nestedHash }]);
      const baseTree = repo.createTree([
        { mode: "100644", name: "tracked.txt", hash: trackedHash },
        { mode: "040000", name: "dir", hash: dirTree },
      ]);
      const { worktree, reopen } = createPersistentWorktree(repo, { baseTree });

      worktree.writeFile("tracked.txt", bytes("tracked-edited"));
      worktree.writeFile("fresh.txt", bytes("fresh"));
      worktree.delete("dir");

      const reopened = reopen();
      expect(reopened.baseTree).toBe(baseTree);
      expect(bytesToUtf8(reopened.readFile("tracked.txt"))).toBe("tracked-edited");
      expect(bytesToUtf8(reopened.readFile("fresh.txt"))).toBe("fresh");
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

      worktree.writeFile("a.txt", bytes("moved"));
      worktree.move("a.txt", "deep/nested/b.txt");
      worktree.mkdir("a.txt");
      worktree.writeFile("a.txt/c.txt", bytes("child"));

      const reopened = reopen();
      expect(bytesToUtf8(reopened.readFile("deep/nested/b.txt"))).toBe("moved");
      expect(bytesToUtf8(reopened.readFile("a.txt/c.txt"))).toBe("child");
      expect(
        reopened
          .readdir()
          .map((entry) => entry.name)
          .sort(),
      ).toEqual(["a.txt", "deep"]);
    });

    test("重新打开后继续向既有目录写入不会触发父目录类型错乱", () => {
      const repo = createMemoryRepository();
      const { worktree, reopen } = createPersistentWorktree(repo, {
        baseTree: repo.createTree([]),
      });

      worktree.mkdir("a");

      const reopened = reopen();
      expect(() => reopened.writeFile("a/x.txt", bytes("x"))).not.toThrow();
      expect(bytesToUtf8(reopened.readFile("a/x.txt"))).toBe("x");
    });

    test("重新打开后新建同级节点不会覆盖未访问的深层持久化节点", () => {
      const repo = createMemoryRepository();
      const { worktree, reopen } = createPersistentWorktree(repo, {
        baseTree: repo.createTree([]),
      });

      worktree.mkdir("a");
      worktree.writeFile("a/b.txt", bytes("nested"));

      const reopened = reopen();
      reopened.writeFile("c.txt", bytes("root"));

      expect(bytesToUtf8(reopened.readFile("a/b.txt"))).toBe("nested");
      expect(bytesToUtf8(reopened.readFile("c.txt"))).toBe("root");
    });

    test("writeTree 后重新打开仍保留当前 overlay，且 baseTree 不变", () => {
      const repo = createMemoryRepository();
      const baseTree = repo.createTree([]);
      const { worktree, reopen } = createPersistentWorktree(repo, { baseTree });

      worktree.writeFile("file.txt", bytes("data"));
      const writtenTree = worktree.writeTree();

      expect(writtenTree).not.toBe(baseTree);

      const reopened = reopen();
      expect(reopened.baseTree).toBe(baseTree);
      expect(bytesToUtf8(reopened.readFile("file.txt"))).toBe("data");
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
      const afterHash = repo.writeBlob(bytes("after"));
      const nextTree = repo.createTree([{ mode: "100644", name: "after.txt", hash: afterHash }]);
      const { worktree, reopen } = createPersistentWorktree(repo, {
        baseTree: repo.createTree([]),
      });

      worktree.writeFile("before.txt", bytes("before"));
      worktree.reset(nextTree);

      const reopened = reopen();
      expect(reopened.baseTree).toBe(nextTree);
      expect(reopened.exists("before.txt")).toBe(false);
      expect(bytesToUtf8(reopened.readFile("after.txt"))).toBe("after");
      expect(reopened.diff()).toEqual([]);
    });
  });
});
