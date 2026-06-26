/**
 * workdir/workdir.ts delete 操作单元测试
 */
import { describe, test, expect } from "bun:test";

import { VirtualPathNotFoundError } from "@/core/errors.ts";
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

describe("delete", () => {
  test("删除根路径抛错误", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    expect(() => session.delete("")).toThrow(/Path must not be empty/);
  });

  test("删除新建文件", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("f.txt", Buffer.from("data"));
    expect(session.exists("f.txt")).toBe(true);
    session.delete("f.txt");
    expect(session.exists("f.txt")).toBe(false);
  });

  test("删除新建目录", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("dir");
    expect(session.exists("dir")).toBe(true);
    session.delete("dir");
    expect(session.exists("dir")).toBe(false);
    expect(session.diff()).toEqual([]);
  });

  test("删除 repo-backed 文件", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    expect(session.exists("f")).toBe(true);
    session.delete("f");
    expect(session.exists("f")).toBe(false);
  });

  test("删除不存在的路径抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });
    expect(() => session.delete("no/such")).toThrow(VirtualPathNotFoundError);
  });

  test("force 时删除不存在的路径不报错", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });
    expect(() => session.delete("no/such", { force: true })).not.toThrow();
  });

  test("force 时重复删除已删除路径不报错", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });
    session.writeFile("f.txt", Buffer.from("data"));
    session.delete("f.txt");
    expect(() => session.delete("f.txt", { force: true })).not.toThrow();
  });

  test("删除目录后同名写文件不会残留子路径 diff", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

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
});
