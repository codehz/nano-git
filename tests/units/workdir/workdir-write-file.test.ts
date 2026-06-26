/**
 * workdir/workdir.ts writeFile / writeLink 操作单元测试
 */
import { describe, test, expect } from "bun:test";

import { VirtualNotFileError, VirtualPathNotFoundError } from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdirMemoryStateStore } from "@/workdir/memory-backend.ts";
import { createVirtualWorkdir, openVirtualWorkdir } from "@/workdir/workdir.ts";

import type { GitTree } from "@/core/types.ts";
import type { Repository } from "@/repository/types.ts";
import type { VirtualWorkdirStateStore } from "@/workdir/state-store.ts";

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

describe("writeFile", () => {
  test("同一个 origin blob hash 的不同路径改写时互不影响", () => {
    const repo = createMemoryRepository();
    const sharedBlobHash = repo.writeBlob(Buffer.from("shared"));
    const baseTree = repo.createTree([
      { mode: "100644", name: "a.txt", hash: sharedBlobHash },
      { mode: "100644", name: "b.txt", hash: sharedBlobHash },
    ]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    expect(session.readFile("a.txt").toString()).toBe("shared");
    expect(session.readFile("b.txt").toString()).toBe("shared");

    session.writeFile("a.txt", Buffer.from("edited-a"));

    expect(session.readFile("a.txt").toString()).toBe("edited-a");
    expect(session.readFile("b.txt").toString()).toBe("shared");
    expect(session.diff()).toMatchObject([
      {
        kind: "update",
        path: "a.txt",
        previous: {
          kind: "blob",
          mode: "100644",
        },
        current: {
          kind: "blob",
          mode: "100644",
        },
      },
    ]);
  });

  test("同一个 origin blob hash 在不同目录路径改写时互不影响", () => {
    const repo = createMemoryRepository();
    const sharedBlobHash = repo.writeBlob(Buffer.from("shared"));
    const leftTree = repo.createTree([{ mode: "100644", name: "same.txt", hash: sharedBlobHash }]);
    const rightTree = repo.createTree([{ mode: "100644", name: "same.txt", hash: sharedBlobHash }]);
    const baseTree = repo.createTree([
      { mode: "040000", name: "left", hash: leftTree },
      { mode: "040000", name: "right", hash: rightTree },
    ]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("left/same.txt", Buffer.from("left-only"));

    expect(session.readFile("left/same.txt").toString()).toBe("left-only");
    expect(session.readFile("right/same.txt").toString()).toBe("shared");
  });

  test("新建文件并读取", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("hello.txt", Buffer.from("Hello World"));
    expect(session.exists("hello.txt")).toBe(true);
    expect(session.readFile("hello.txt").toString()).toBe("Hello World");
    expect(session.stat("hello.txt")).toMatchObject({ kind: "blob", mode: "100644", size: 11 });
  });

  test("新建可执行文件 mode 100755", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("run.sh", Buffer.from("#!/bin/sh"), { mode: "100755" });
    expect(session.stat("run.sh")).toMatchObject({ kind: "blob", mode: "100755" });
  });

  test("覆盖已有文件", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("old"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    expect(session.readFile("f").toString()).toBe("old");
    session.writeFile("f", Buffer.from("new content"));
    expect(session.readFile("f").toString()).toBe("new content");
  });

  test("在目录路径上写文件抛 VirtualNotFileError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });
    session.mkdir("dir");
    expect(() => session.writeFile("dir", Buffer.from("x"))).toThrow(VirtualNotFileError);
  });

  test("父目录不存在抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });
    expect(() => session.writeFile("no/such.txt", Buffer.from("x"))).toThrow(
      VirtualPathNotFoundError,
    );
  });

  test("嵌套路径下写文件", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });
    session.mkdir("a");
    session.mkdir("a/b");
    session.writeFile("a/b/f.txt", Buffer.from("deep"));
    expect(session.readFile("a/b/f.txt").toString()).toBe("deep");
  });

  test("写入中途失败时回滚到调用前状态", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const inner = createVirtualWorkdirMemoryStateStore(baseTree);
    let failOnSetNode = true;
    const store: VirtualWorkdirStateStore = {
      kind: inner.kind,
      transact<T>(fn: () => T): T {
        return inner.transact(fn);
      },
      readBaseTree(): import("@/core/types.ts").SHA1 {
        return inner.readBaseTree();
      },
      writeBaseTree(nextBaseTree): void {
        inner.writeBaseTree(nextBaseTree);
      },
      getNode(id) {
        return inner.getNode(id);
      },
      setNode(node): void {
        inner.setNode(node);
        if (failOnSetNode) {
          failOnSetNode = false;
          throw new Error("setNode failed");
        }
      },
      deleteNode(id): void {
        inner.deleteNode(id);
      },
      listChangeRecords() {
        return inner.listChangeRecords();
      },
      getChangeRecord(path) {
        return inner.getChangeRecord(path);
      },
      setChangeRecord(record): void {
        inner.setChangeRecord(record);
      },
      deleteChangeRecord(path): void {
        inner.deleteChangeRecord(path);
      },
      listDirtyDirSummaries() {
        return inner.listDirtyDirSummaries();
      },
      getDirtyDirSummary(path) {
        return inner.getDirtyDirSummary(path);
      },
      setDirtyDirSummary(summary): void {
        inner.setDirtyDirSummary(summary);
      },
      deleteDirtyDirSummary(path): void {
        inner.deleteDirtyDirSummary(path);
      },
      reset(nextBaseTree): void {
        inner.reset(nextBaseTree);
      },
    };

    const session = openVirtualWorkdir(repo.objects, store);

    expect(() => session.writeFile("broken.txt", Buffer.from("data"))).toThrow(/setNode failed/);
    expect(session.exists("broken.txt")).toBe(false);
    expect(session.diff()).toEqual([]);
    expect(inner.readBaseTree()).toBe(baseTree);
  });
});

// ==================== writeLink ====================

describe("writeLink", () => {
  test("同一个 origin symlink blob hash 的不同路径改写时互不影响", () => {
    const repo = createMemoryRepository();
    const sharedLinkHash = repo.writeBlob(Buffer.from("target\n"));
    const baseTree = repo.createTree([
      { mode: "120000", name: "a", hash: sharedLinkHash },
      { mode: "120000", name: "b", hash: sharedLinkHash },
    ]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeLink("a", "edited-target");

    expect(session.readLink("a")).toBe("edited-target");
    expect(session.readLink("b")).toBe("target\n");
  });

  test("新建符号链接并读取", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeLink("link", "target/path");
    expect(session.exists("link")).toBe(true);
    expect(session.readLink("link")).toBe("target/path");
    expect(session.stat("link")).toMatchObject({ kind: "symlink", mode: "120000" });
  });

  test("覆盖已有符号链接", () => {
    const repo = createMemoryRepository();
    const linkHash = repo.writeBlob(Buffer.from("old-target"));
    const baseTree = repo.createTree([{ mode: "120000", name: "l", hash: linkHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    expect(session.readLink("l")).toBe("old-target");
    session.writeLink("l", "new-target");
    expect(session.readLink("l")).toBe("new-target");
  });

  test("在目录上写符号链接抛 VirtualNotFileError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });
    session.mkdir("dir");
    expect(() => session.writeLink("dir", "x")).toThrow(VirtualNotFileError);
  });
});
