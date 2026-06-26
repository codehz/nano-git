/**
 * workdir/workdir.ts mkdir 操作单元测试
 */
import { describe, test, expect } from "bun:test";

import {
  VirtualNotDirectoryError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
} from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdir } from "@/workdir/workdir.ts";

import type { GitTree } from "@/core/types.ts";
import type { Repository } from "@/repository/types.ts";

/** 读取 tree 对象（类型断言辅助） */
function readTree(repo: Repository, hash: string): GitTree {
  const obj = repo.catFile(hash as import("@/core/types.ts").SHA1);
  if (obj.type !== "tree") throw new Error(`Expected tree, got ${obj.type}`);
  return obj;
}

/** 读取 blob 内容（类型断言辅助） */
function readBlob(repo: Repository, hash: string): Buffer {
  const obj = repo.catFile(hash as import("@/core/types.ts").SHA1);
  if (obj.type !== "blob") throw new Error(`Expected blob, got ${obj.type}`);
  return obj.content;
}

describe("mkdir", () => {
  test("根下新建目录", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.mkdir("src");
    expect(session.exists("src")).toBe(true);
    expect(session.stat("src")).toMatchObject({ kind: "tree", mode: "040000" });
    expect(session.readdir()).toEqual([{ name: "src", kind: "tree", mode: "040000" }]);
    expect(session.readdir("src")).toEqual([]);
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

  test("嵌套目录", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.mkdir("a");
    session.mkdir("a/b");
    session.mkdir("a/b/c");

    expect(session.exists("a/b/c")).toBe(true);
    expect(session.stat("a/b/c")).toMatchObject({ kind: "tree" });
    expect(session.readdir("a/b")).toEqual([{ name: "c", kind: "tree", mode: "040000" }]);
  });

  test("父目录不存在时抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });
    expect(() => session.mkdir("no/such")).toThrow(VirtualPathNotFoundError);
  });

  test("重复创建抛 VirtualPathAlreadyExistsError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });
    session.mkdir("x");
    expect(() => session.mkdir("x")).toThrow(VirtualPathAlreadyExistsError);
  });

  test("在文件下创建目录抛 VirtualNotDirectoryError", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });
    expect(() => session.mkdir("f/sub")).toThrow(VirtualNotDirectoryError);
  });

  test("recursive 一次创建多级目录", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("a/b/c", { recursive: true });

    expect(session.exists("a/b/c")).toBe(true);
    expect(session.stat("a/b/c")).toMatchObject({ kind: "tree" });
    expect(session.readdir("a/b")).toEqual([{ name: "c", kind: "tree", mode: "040000" }]);
  });

  test("recursive 目标已是目录时不报错", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("dir");
    session.mkdir("dir", { recursive: true });
    session.mkdir("dir/sub", { recursive: true });

    expect(session.exists("dir/sub")).toBe(true);
  });

  test("recursive 路径上存在文件时抛 VirtualNotDirectoryError", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    expect(() => session.mkdir("f/sub", { recursive: true })).toThrow(VirtualNotDirectoryError);
  });

  test("recursive 目标路径已是文件时抛 VirtualNotDirectoryError", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    expect(() => session.mkdir("f", { recursive: true })).toThrow(VirtualNotDirectoryError);
  });

  test("未传 recursive 时父目录不存在仍抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });
    expect(() => session.mkdir("no/such")).toThrow(VirtualPathNotFoundError);
  });
});
