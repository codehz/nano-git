/**
 * VirtualWorktree 合同测试：读取与基础写入语义
 */
import { describe, expect, test } from "bun:test";

import { virtualWorktreeBackends } from "./contract.ts";
import {
  VirtualNotDirectoryError,
  VirtualNotFileError,
  VirtualOriginUnavailableError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
} from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorktree contract: read/write", () => {
  describe.each(virtualWorktreeBackends)("$name", ({ createWorktree }) => {
    test("从空 tree 打开并写入文件/目录/符号链接", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      expect(session.readdir()).toEqual([]);
      session.mkdir("dir");
      session.writeFile("dir/file.txt", Buffer.from("hello"));
      session.writeLink("link", "target");

      expect(session.readFile("dir/file.txt").toString()).toBe("hello");
      expect(session.readLink("link")).toBe("target");
      expect(session.readdir().map((entry) => entry.name)).toEqual(["dir", "link"]);
    });

    test("writeFile 支持新建、覆盖与可执行 mode", () => {
      const repo = createMemoryRepository();
      const original = repo.writeBlob(Buffer.from("old"));
      const session = createWorktree(repo, {
        baseTree: repo.createTree([{ mode: "100644", name: "file.txt", hash: original }]),
      });

      session.writeFile("new.txt", Buffer.from("new"));
      session.writeFile("script.sh", Buffer.from("#!/bin/sh"), { mode: "100755" });
      session.writeFile("file.txt", Buffer.from("updated"));

      expect(session.readFile("new.txt").toString()).toBe("new");
      expect(session.stat("script.sh")).toMatchObject({ kind: "blob", mode: "100755" });
      expect(session.readFile("file.txt").toString()).toBe("updated");
    });

    test("writeFile 在共享 origin blob 的路径上修改时互不影响", () => {
      const repo = createMemoryRepository();
      const sharedBlobHash = repo.writeBlob(Buffer.from("shared"));
      const baseTree = repo.createTree([
        { mode: "100644", name: "a.txt", hash: sharedBlobHash },
        { mode: "100644", name: "b.txt", hash: sharedBlobHash },
      ]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("a.txt", Buffer.from("edited-a"));

      expect(session.readFile("a.txt").toString()).toBe("edited-a");
      expect(session.readFile("b.txt").toString()).toBe("shared");
    });

    test("writeFile 在共享 origin blob 的不同目录路径上修改时互不影响", () => {
      const repo = createMemoryRepository();
      const sharedBlobHash = repo.writeBlob(Buffer.from("shared"));
      const leftTree = repo.createTree([
        { mode: "100644", name: "same.txt", hash: sharedBlobHash },
      ]);
      const rightTree = repo.createTree([
        { mode: "100644", name: "same.txt", hash: sharedBlobHash },
      ]);
      const baseTree = repo.createTree([
        { mode: "040000", name: "left", hash: leftTree },
        { mode: "040000", name: "right", hash: rightTree },
      ]);
      const session = createWorktree(repo, { baseTree });

      session.writeFile("left/same.txt", Buffer.from("left-only"));

      expect(session.readFile("left/same.txt").toString()).toBe("left-only");
      expect(session.readFile("right/same.txt").toString()).toBe("shared");
    });

    test("writeFile 嵌套写入需要已有父目录", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      expect(() => session.writeFile("no/such.txt", Buffer.from("x"))).toThrow(
        VirtualPathNotFoundError,
      );

      session.mkdir("a/b", { recursive: true });
      session.writeFile("a/b/file.txt", Buffer.from("deep"));
      expect(session.readFile("a/b/file.txt").toString()).toBe("deep");
    });

    test("writeFile 在目录路径上报 VirtualNotFileError", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("dir");
      expect(() => session.writeFile("dir", Buffer.from("x"))).toThrow(VirtualNotFileError);
    });

    test("writeLink 支持新建、覆盖与共享 origin 独立修改", () => {
      const repo = createMemoryRepository();
      const sharedLinkHash = repo.writeBlob(Buffer.from("target\n"));
      const session = createWorktree(repo, {
        baseTree: repo.createTree([
          { mode: "120000", name: "a", hash: sharedLinkHash },
          { mode: "120000", name: "b", hash: sharedLinkHash },
        ]),
      });

      session.writeLink("a", "edited-target");
      session.writeLink("link", "target/path");

      expect(session.readLink("a")).toBe("edited-target");
      expect(session.readLink("b")).toBe("target\n");
      expect(session.readLink("link")).toBe("target/path");
      expect(session.stat("link")).toMatchObject({ kind: "symlink", mode: "120000" });
    });

    test("writeLink 可覆盖已有符号链接", () => {
      const repo = createMemoryRepository();
      const linkHash = repo.writeBlob(Buffer.from("old-target"));
      const session = createWorktree(repo, {
        baseTree: repo.createTree([{ mode: "120000", name: "link", hash: linkHash }]),
      });

      session.writeLink("link", "new-target");
      expect(session.readLink("link")).toBe("new-target");
    });

    test("writeLink 在目录路径上报 VirtualNotFileError", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("dir");
      expect(() => session.writeLink("dir", "x")).toThrow(VirtualNotFileError);
    });

    test("从非空 tree 打开并读取 repo-backed 文件、目录、符号链接", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("hello"));
      const linkHash = repo.writeBlob(Buffer.from("target"));
      const dirHash = repo.createTree([{ mode: "100644", name: "nested.txt", hash: fileHash }]);
      const baseTree = repo.createTree([
        { mode: "100644", name: "file.txt", hash: fileHash },
        { mode: "040000", name: "dir", hash: dirHash },
        { mode: "120000", name: "link", hash: linkHash },
      ]);
      const session = createWorktree(repo, { baseTree });

      expect(session.readFile("file.txt").toString()).toBe("hello");
      expect(session.readFile("dir/nested.txt").toString()).toBe("hello");
      expect(session.readLink("link")).toBe("target");
      expect(session.stat("file.txt")).toMatchObject({
        kind: "blob",
        mode: "100644",
        hash: fileHash,
      });
      expect(session.stat("dir")).toMatchObject({
        kind: "tree",
        mode: "040000",
        hash: dirHash,
      });
    });

    test("origin 缺失时报 VirtualOriginUnavailableError", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("gone"));
      const session = createWorktree(repo, {
        baseTree: repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]),
      });

      repo.objects.delete(fileHash);
      expect(() => session.readFile("file.txt")).toThrow(VirtualOriginUnavailableError);
    });

    test("对符号链接 readFile 报 VirtualNotFileError", () => {
      const repo = createMemoryRepository();
      const linkHash = repo.writeBlob(Buffer.from("target"));
      const session = createWorktree(repo, {
        baseTree: repo.createTree([{ mode: "120000", name: "link", hash: linkHash }]),
      });

      expect(() => session.readFile("link")).toThrow(VirtualNotFileError);
    });

    test("mkdir recursive 支持一次创建多级目录", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("a/b/c", { recursive: true });

      expect(session.readdir("a")).toEqual([{ name: "b", kind: "tree", mode: "040000" }]);
      expect(session.readdir("a/b")).toEqual([{ name: "c", kind: "tree", mode: "040000" }]);
      expect(session.stat("a/b/c")).toMatchObject({ kind: "tree", mode: "040000" });
    });

    test("mkdir recursive 目标已存在目录时保持幂等", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("dir");
      session.mkdir("dir", { recursive: true });
      session.mkdir("dir/sub", { recursive: true });

      expect(session.exists("dir/sub")).toBe(true);
    });

    test("mkdir 在文件路径下建子目录时报 VirtualNotDirectoryError", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("data"));
      const session = createWorktree(repo, {
        baseTree: repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]),
      });

      expect(() => session.mkdir("file.txt/sub")).toThrow(VirtualNotDirectoryError);
    });

    test("mkdir 非 recursive 且父目录不存在时报 VirtualPathNotFoundError", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      expect(() => session.mkdir("missing/child")).toThrow(VirtualPathNotFoundError);
    });

    test("重复 mkdir 同一路径时报 VirtualPathAlreadyExistsError", () => {
      const repo = createMemoryRepository();
      const session = createWorktree(repo, { baseTree: repo.createTree([]) });

      session.mkdir("dir");
      expect(() => session.mkdir("dir")).toThrow(VirtualPathAlreadyExistsError);
    });

    // ====== 以下测试由单后端 worktree-read / worktree-mkdir 转换而来 ======

    test("空 tree 根目录可读", () => {
      const repo = createMemoryRepository();
      const baseTree = repo.createTree([]);
      const session = createWorktree(repo, { baseTree });

      expect(session.baseTree).toBe(baseTree);
      expect(session.exists("")).toBe(true);
      expect(session.readdir()).toEqual([]);
      expect(session.readdir("")).toEqual([]);
      expect(session.stat("")).toEqual({
        kind: "tree",
        mode: "040000",
        size: 0,
        hash: baseTree,
      });
    });

    test("mkdir recursive 在文件路径上存在文件时报 VirtualNotDirectoryError", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("data"));
      const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      expect(() => session.mkdir("f/sub", { recursive: true })).toThrow(VirtualNotDirectoryError);
    });

    test("mkdir recursive 目标路径已是文件时报 VirtualNotDirectoryError", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("data"));
      const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: fileHash }]);
      const session = createWorktree(repo, { baseTree });

      expect(() => session.mkdir("f", { recursive: true })).toThrow(VirtualNotDirectoryError);
    });
  });
});
