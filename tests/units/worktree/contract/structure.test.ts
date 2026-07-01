/**
 * VirtualWorktree 合同测试：结构变更语义
 */
import { describe, expect, test } from "bun:test";

import { virtualWorktreeBackends } from "./contract.ts";
import {
  VirtualNotDirectoryError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
} from "@/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

import type { GitTree, SHA1 } from "@/types/index.ts";

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

describe("VirtualWorktree contract: structure", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    test("删除路径后不可见", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("gone"));
      const session = createWorktree(repo, {
        baseTree: repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]),
      });

      session.delete("file.txt");
      expect(session.exists("file.txt")).toBe(false);
      expect(() => session.readFile("file.txt")).toThrow(VirtualPathNotFoundError);
    });

    test("删除根路径时报错", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      expect(() => session.delete("")).toThrow(/Path must not be empty/);
    });

    test("force 删除不存在路径时保持幂等", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      expect(() => session.delete("missing", { force: true })).not.toThrow();
      session.writeFile("file.txt", Buffer.from("data"));
      session.delete("file.txt");
      expect(() => session.delete("file.txt", { force: true })).not.toThrow();
    });

    test("删除目录后同名写文件不会残留旧子路径", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("manuscript");
      session.writeFile("manuscript/a.md", Buffer.from("a"));
      session.delete("manuscript", { force: true });
      session.writeFile("manuscript", Buffer.from("file-now"));

      expect(session.stat("manuscript")).toMatchObject({ kind: "blob", mode: "100644", size: 8 });
      expect(session.diff()).toMatchObject([
        {
          kind: "create",
          path: "manuscript",
          current: { kind: "blob", mode: "100644" },
        },
      ]);
    });

    test("move 文件与目录保持可读", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.writeFile("src/main.ts", Buffer.from("code"));
      session.move("src/main.ts", "src/index.ts");
      session.move("src", "lib");

      expect(session.exists("src")).toBe(false);
      expect(session.readFile("lib/index.ts").toString()).toBe("code");
    });

    test("move 可自动创建目标父目录", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", Buffer.from("nested"));
      session.move("a.txt", "other/deep/b.txt");

      expect(session.exists("a.txt")).toBe(false);
      expect(session.readFile("other/deep/b.txt").toString()).toBe("nested");
    });

    test("move 到文件父路径下时报 VirtualNotDirectoryError", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("from.txt", Buffer.from("data"));
      session.writeFile("target", Buffer.from("blocking parent"));

      expect(() => session.move("from.txt", "target/child.txt")).toThrow(VirtualNotDirectoryError);
    });

    test("move 目录到自身子目录时报错", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.writeFile("src/main.ts", Buffer.from("code"));

      expect(() => session.move("src", "src/nested")).toThrow(
        /destination is a subdirectory of source/,
      );
    });

    test("move 到已存在路径时报 VirtualPathAlreadyExistsError", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", Buffer.from("a"));
      session.writeFile("b.txt", Buffer.from("b"));

      expect(() => session.move("a.txt", "b.txt")).toThrow(VirtualPathAlreadyExistsError);
    });

    test("copy 文件与目录后可独立修改", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.writeFile("src/main.ts", Buffer.from("v1"));
      session.copy("src", "src-copy");
      session.writeFile("src/main.ts", Buffer.from("v2"));

      expect(session.readFile("src/main.ts").toString()).toBe("v2");
      expect(session.readFile("src-copy/main.ts").toString()).toBe("v1");
    });

    test("copy 到文件父路径下时报 VirtualNotDirectoryError", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("from.txt", Buffer.from("data"));
      session.writeFile("target", Buffer.from("blocking parent"));

      expect(() => session.copy("from.txt", "target/child.txt")).toThrow(VirtualNotDirectoryError);
    });

    test("copy 目录到自身子目录时源和目标都可读", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("src");
      session.writeFile("src/main.ts", Buffer.from("code"));
      session.copy("src", "src/nested");

      expect(session.readFile("src/main.ts").toString()).toBe("code");
      expect(session.readFile("src/nested/main.ts").toString()).toBe("code");
    });

    test("copy 到已存在路径时报 VirtualPathAlreadyExistsError", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", Buffer.from("a"));
      session.writeFile("b.txt", Buffer.from("b"));

      expect(() => session.copy("a.txt", "b.txt")).toThrow(VirtualPathAlreadyExistsError);
    });

    // ====== 以下测试由单后端 worktree-move / worktree-copy / worktree-delete 转换而来 ======

    test("move 空目录产出 remove + create diff", () => {
      const repo = createMemoryRepository();
      const emptyTree = repo.createTree([]);
      const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: emptyTree }]);
      const session = createWorktree(repo, { baseTree });

      session.move("src", "lib");

      expect(session.diff()).toMatchObject([
        {
          kind: "create",
          path: "lib",
          current: { kind: "tree", mode: "040000", hash: emptyTree },
        },
        {
          kind: "remove",
          path: "src",
          previous: { kind: "tree", mode: "040000", hash: emptyTree },
        },
      ]);
    });

    test("move 后 writeTree 不制造额外 blob", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("old.txt", Buffer.from("content"));
      session.move("old.txt", "new.txt");
      const tree = session.writeTree();

      const treeObj = readTree(repo, tree);
      expect(treeObj.entries).toHaveLength(1);
      expect(treeObj.entries[0]!.name).toBe("new.txt");
      expect(readBlob(repo, treeObj.entries[0]!.hash).toString()).toBe("content");
    });

    test("move 后修改内容仍表现为 remove + create", () => {
      const repo = createMemoryRepository();
      const blobHash = repo.writeBlob(Buffer.from("data"));
      const session = createWorktree(repo, {
        baseTree: repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]),
      });

      session.move("a.txt", "b.txt");
      session.writeFile("b.txt", Buffer.from("changed"));

      const diff = session.diff();
      expect(diff.find((entry) => entry.path === "a.txt")).toMatchObject({
        kind: "remove",
        path: "a.txt",
        previous: { kind: "blob", mode: "100644" },
      });
      expect(diff.find((entry) => entry.path === "b.txt")).toMatchObject({
        kind: "create",
        path: "b.txt",
        current: { kind: "blob", mode: "100644" },
      });
    });

    test("删除 move 目标仍保持全量语义正确", () => {
      const repo = createMemoryRepository();
      const blobHash = repo.writeBlob(Buffer.from("data"));
      const session = createWorktree(repo, {
        baseTree: repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]),
      });

      session.move("a.txt", "b.txt");
      session.delete("b.txt");

      expect(session.diff()).toMatchObject([
        {
          kind: "remove",
          path: "a.txt",
          previous: { kind: "blob", mode: "100644" },
        },
      ]);
    });

    test("move 到自身为无操作", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("f.txt", Buffer.from("data"));
      session.move("f.txt", "f.txt");
      expect(session.exists("f.txt")).toBe(true);
      expect(session.readFile("f.txt").toString()).toBe("data");
      expect(session.diff()).toMatchObject([
        {
          kind: "create",
          path: "f.txt",
          current: { kind: "blob", mode: "100644" },
        },
      ]);
    });

    test("复制后 writeTree 验证导出正确", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.writeFile("a.txt", Buffer.from("data"));
      session.copy("a.txt", "b.txt");
      const tree = session.writeTree();

      const treeObj = readTree(repo, tree);
      const names = treeObj.entries.map((e) => e.name).sort();
      expect(names).toEqual(["a.txt", "b.txt"]);
    });

    test("删除不存在的路径抛 VirtualPathNotFoundError", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      expect(() => session.delete("no/such")).toThrow(VirtualPathNotFoundError);
    });
  });
});
