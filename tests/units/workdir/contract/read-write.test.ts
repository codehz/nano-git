/**
 * VirtualWorkdir 合同测试：读取与基础写入语义
 */
import { describe, expect, test } from "bun:test";

import { virtualWorkdirBackends } from "./contract.ts";
import {
  VirtualNotDirectoryError,
  VirtualNotFileError,
  VirtualOriginUnavailableError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
} from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

describe("VirtualWorkdir contract: read/write", () => {
  describe.each(virtualWorkdirBackends)("$name", ({ createWorkdir }) => {
    test("从空 tree 打开并写入文件/目录/符号链接", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      expect(session.readdir()).toEqual([]);
      session.mkdir("dir");
      session.writeFile("dir/file.txt", Buffer.from("hello"));
      session.writeLink("link", "target");

      expect(session.readFile("dir/file.txt").toString()).toBe("hello");
      expect(session.readLink("link")).toBe("target");
      expect(session.readdir().map((entry) => entry.name)).toEqual(["dir", "link"]);
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
      const session = createWorkdir(repo, { baseTree });

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
      const session = createWorkdir(repo, {
        baseTree: repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]),
      });

      repo.objects.delete(fileHash);
      expect(() => session.readFile("file.txt")).toThrow(VirtualOriginUnavailableError);
    });

    test("对符号链接 readFile 报 VirtualNotFileError", () => {
      const repo = createMemoryRepository();
      const linkHash = repo.writeBlob(Buffer.from("target"));
      const session = createWorkdir(repo, {
        baseTree: repo.createTree([{ mode: "120000", name: "link", hash: linkHash }]),
      });

      expect(() => session.readFile("link")).toThrow(VirtualNotFileError);
    });

    test("mkdir recursive 支持一次创建多级目录", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.mkdir("a/b/c", { recursive: true });

      expect(session.readdir("a")).toEqual([{ name: "b", kind: "tree", mode: "040000" }]);
      expect(session.readdir("a/b")).toEqual([{ name: "c", kind: "tree", mode: "040000" }]);
      expect(session.stat("a/b/c")).toMatchObject({ kind: "tree", mode: "040000" });
    });

    test("mkdir recursive 目标已存在目录时保持幂等", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.mkdir("dir");
      session.mkdir("dir", { recursive: true });
      session.mkdir("dir/sub", { recursive: true });

      expect(session.exists("dir/sub")).toBe(true);
    });

    test("mkdir 在文件路径下建子目录时报 VirtualNotDirectoryError", () => {
      const repo = createMemoryRepository();
      const fileHash = repo.writeBlob(Buffer.from("data"));
      const session = createWorkdir(repo, {
        baseTree: repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]),
      });

      expect(() => session.mkdir("file.txt/sub")).toThrow(VirtualNotDirectoryError);
    });

    test("mkdir 非 recursive 且父目录不存在时报 VirtualPathNotFoundError", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      expect(() => session.mkdir("missing/child")).toThrow(VirtualPathNotFoundError);
    });

    test("重复 mkdir 同一路径时报 VirtualPathAlreadyExistsError", () => {
      const repo = createMemoryRepository();
      const session = createWorkdir(repo, { baseTree: repo.createTree([]) });

      session.mkdir("dir");
      expect(() => session.mkdir("dir")).toThrow(VirtualPathAlreadyExistsError);
    });
  });
});
