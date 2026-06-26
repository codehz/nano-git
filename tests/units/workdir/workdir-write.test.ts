/**
 * workdir/workdir.ts 写入操作单元测试（Phase 4）
 */
import { describe, test, expect } from "bun:test";

import {
  VirtualNotDirectoryError,
  VirtualNotFileError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
  VirtualRevertNotSupportedError,
} from "@/core/errors.ts";
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

// ==================== mkdir ====================

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

// ==================== writeFile ====================

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

// ==================== delete ====================

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

// ==================== writeTree ====================

describe("writeTree", () => {
  test("空 workdir writeTree 返回 baseTree", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    expect(session.writeTree()).toBe(baseTree);
  });

  test("新建单文件后 writeTree", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("a.txt", Buffer.from("hello"));
    const newTree = session.writeTree();
    expect(newTree).not.toBe(baseTree);

    // 用 repo 读取导出的 tree 验证内容
    const tree = readTree(repo, newTree);
    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]!.name).toBe("a.txt");
    expect(tree.entries[0]!.mode).toBe("100644");

    const blob = readBlob(repo, tree.entries[0]!.hash);
    expect(blob.toString()).toBe("hello");
  });

  test("新建文件后可继续读取", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("f.txt", Buffer.from("data"));
    session.writeTree();
    // 继续读取（overlay 未清空）
    expect(session.readFile("f.txt").toString()).toBe("data");
  });

  test("连续多次 writeTree 结果可重复", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("f.txt", Buffer.from("stable"));
    const hash1 = session.writeTree();
    const hash2 = session.writeTree();
    expect(hash1).toBe(hash2);
  });

  test("未修改路径的 blob hash 保持稳定复用", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("unchanged"));
    const baseTree = repo.createTree([{ mode: "100644", name: "old.txt", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    // 只新增一个文件，不动 old.txt
    session.writeFile("new.txt", Buffer.from("new"));
    const newTree = session.writeTree();

    const tree = readTree(repo, newTree);
    const oldEntry = tree.entries.find((e) => e.name === "old.txt");
    expect(oldEntry).toBeDefined();
    // old.txt 应复用原 blob
    expect(oldEntry!.hash).toBe(blobHash);
  });

  test("嵌套目录+多文件 writeTree", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("src");
    session.writeFile("src/main.ts", Buffer.from("console.log(1)"));
    session.writeFile("src/lib.ts", Buffer.from("export {}"));
    session.writeFile("README.md", Buffer.from("# Project"));

    const newTree = session.writeTree();
    const tree = readTree(repo, newTree);
    expect(tree.entries).toHaveLength(2); // src + README.md
    const names = tree.entries.map((e) => e.name).sort();
    expect(names).toEqual(["README.md", "src"]);

    // 读取 src 子树
    const srcEntry = tree.entries.find((e) => e.name === "src")!;
    expect(srcEntry.mode).toBe("040000");
    const srcTree = readTree(repo, srcEntry.hash);
    const srcNames = srcTree.entries.map((e) => e.name).sort();
    expect(srcNames).toEqual(["lib.ts", "main.ts"]);
  });

  test("writeTree 后 baseTree 不变", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("f.txt", Buffer.from("data"));
    session.writeTree();
    expect(session.baseTree).toBe(baseTree);
  });

  test("新建空目录后 writeTree", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("empty");
    const newTree = session.writeTree();
    const tree = readTree(repo, newTree);
    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]!.name).toBe("empty");
    expect(tree.entries[0]!.mode).toBe("040000");
  });

  test("writeTree 后通过新 workdir 读取验证", () => {
    const repo = createMemoryRepository();
    const session1 = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session1.writeFile("a.txt", Buffer.from("alpha"));
    session1.writeFile("b.txt", Buffer.from("beta"));
    const hash = session1.writeTree();

    // 用新的 workdir 打开导出 tree
    const session2 = createVirtualWorkdir(repo.objects, { baseTree: hash });
    expect(session2.readdir().length).toBe(2);
    expect(session2.readFile("a.txt").toString()).toBe("alpha");
    expect(session2.readFile("b.txt").toString()).toBe("beta");
  });
});

// ==================== listChanges ====================

describe("diff（写入操作）", () => {
  test("新建文件产出 add", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("f.txt", Buffer.from("data"));
    expect(session.diff()).toMatchObject([
      {
        kind: "create",
        path: "f.txt",
        current: {
          kind: "blob",
          mode: "100644",
        },
      },
    ]);
  });

  test("修改文件产出 modify", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("old"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("f", Buffer.from("new"));
    expect(session.diff()).toMatchObject([
      {
        kind: "update",
        path: "f",
        previous: {
          kind: "blob",
          mode: "100644",
        },
        current: {
          kind: "blob",
          mode: "100644",
        },
        changes: {
          kindChanged: false,
          modeChanged: false,
          contentChanged: true,
        },
      },
    ]);
  });

  test("重复修改同一路径时变更记录不膨胀", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.writeFile("f.txt", Buffer.from("v1"));
    session.writeFile("f.txt", Buffer.from("v2"));
    session.writeFile("f.txt", Buffer.from("v3"));

    expect(store.listChangeRecords()).toHaveLength(1);
    expect(session.diff()).toMatchObject([
      {
        kind: "create",
        path: "f.txt",
        current: {
          kind: "blob",
          mode: "100644",
        },
      },
    ]);
  });

  test("删除文件产出 delete", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.delete("f");
    expect(session.diff()).toMatchObject([
      {
        kind: "remove",
        path: "f",
        previous: {
          kind: "blob",
          mode: "100644",
        },
      },
    ]);
  });

  test("删除新增文件时变更记录被清空而不膨胀", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.writeFile("f.txt", Buffer.from("data"));
    expect(store.listChangeRecords()).toHaveLength(1);

    session.delete("f.txt");
    expect(store.listChangeRecords()).toEqual([]);
    expect(session.diff()).toEqual([]);
  });

  test("仅新建目录时输出目录 diff", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("dir");
    expect(session.diff()).toMatchObject([
      {
        kind: "create",
        path: "dir",
        current: {
          kind: "tree",
          mode: "040000",
        },
      },
    ]);
  });

  test("删除空目录产出 remove", () => {
    const repo = createMemoryRepository();
    const emptyTree = repo.createTree([]);
    const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: emptyTree }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.delete("dir");
    expect(session.diff()).toMatchObject([
      {
        kind: "remove",
        path: "dir",
        previous: {
          kind: "tree",
          mode: "040000",
          hash: emptyTree,
        },
      },
    ]);
  });

  test("文件与符号链接互换产出 update 且标记 kindChanged", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeLink("f", "target");
    expect(session.diff()).toMatchObject([
      {
        kind: "update",
        path: "f",
        previous: {
          kind: "blob",
          mode: "100644",
        },
        current: {
          kind: "symlink",
          mode: "120000",
        },
        changes: {
          kindChanged: true,
          modeChanged: true,
          contentChanged: true,
        },
      },
    ]);
  });
});

// ==================== move ====================

describe("move", () => {
  test("将目录移动到自己的子目录抛错误", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("src");
    session.writeFile("src/main.ts", Buffer.from("code"));

    expect(() => session.move("src", "src/nested")).toThrow(
      /destination is a subdirectory of source/,
    );
  });

  test("目标父路径是文件时 move 抛 VirtualNotDirectoryError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("from.txt", Buffer.from("data"));
    session.writeFile("target", Buffer.from("blocking parent"));

    expect(() => session.move("from.txt", "target/child.txt")).toThrow(VirtualNotDirectoryError);
  });

  test("同目录下移动文件", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("old.txt", Buffer.from("content"));
    session.move("old.txt", "new.txt");

    expect(session.exists("old.txt")).toBe(false);
    expect(session.exists("new.txt")).toBe(true);
    expect(session.readFile("new.txt").toString()).toBe("content");
  });

  test("跨目录树移动文件（目标父目录已存在）", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("a.txt", Buffer.from("moved"));
    session.mkdir("sub");
    session.move("a.txt", "sub/b.txt");

    expect(session.exists("a.txt")).toBe(false);
    expect(session.exists("sub/b.txt")).toBe(true);
    expect(session.readFile("sub/b.txt").toString()).toBe("moved");
  });

  test("跨目录树移动文件（自动创建目标父目录）", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("a.txt", Buffer.from("nested"));
    session.move("a.txt", "other/deep/b.txt");

    expect(session.exists("a.txt")).toBe(false);
    expect(session.exists("other/deep/b.txt")).toBe(true);
    expect(session.readFile("other/deep/b.txt").toString()).toBe("nested");
  });

  test("move repo-backed 文件", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("repo data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.move("f", "g");
    expect(session.exists("f")).toBe(false);
    expect(session.exists("g")).toBe(true);
    expect(session.readFile("g").toString()).toBe("repo data");
  });

  test("move 目录", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("src");
    session.writeFile("src/main.ts", Buffer.from("code"));
    session.move("src", "lib");

    expect(session.exists("src")).toBe(false);
    expect(session.exists("lib")).toBe(true);
    expect(session.readFile("lib/main.ts").toString()).toBe("code");
  });

  test("move 空目录产出 move diff", () => {
    const repo = createMemoryRepository();
    const emptyTree = repo.createTree([]);
    const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: emptyTree }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.move("src", "lib");

    expect(session.diff()).toMatchObject([
      {
        kind: "update",
        path: "lib",
        previous: {
          kind: "tree",
          mode: "040000",
          hash: emptyTree,
        },
        current: {
          kind: "tree",
          mode: "040000",
          hash: emptyTree,
        },
        source: {
          kind: "move",
          path: "src",
        },
      },
    ]);
  });

  test("move 后 writeTree 不制造额外 blob", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("old.txt", Buffer.from("content"));
    session.move("old.txt", "new.txt");
    const tree = session.writeTree();

    const treeObj = readTree(repo, tree);
    expect(treeObj.entries).toHaveLength(1);
    expect(treeObj.entries[0]!.name).toBe("new.txt");
    expect(readBlob(repo, treeObj.entries[0]!.hash).toString()).toBe("content");
  });

  test("repo-backed move 产出 move diff", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]),
    });

    session.move("a.txt", "b.txt");
    expect(session.diff()).toMatchObject([
      {
        kind: "update",
        path: "b.txt",
        previous: {
          kind: "blob",
          mode: "100644",
        },
        current: {
          kind: "blob",
          mode: "100644",
        },
        changes: {
          kindChanged: false,
          modeChanged: false,
          contentChanged: false,
        },
        source: {
          kind: "move",
          path: "a.txt",
        },
      },
    ]);
  });

  test("move 后修改内容仍保留 move 来源", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]),
    });

    session.move("a.txt", "b.txt");
    session.writeFile("b.txt", Buffer.from("changed"));

    expect(session.diff()).toMatchObject([
      {
        kind: "update",
        path: "b.txt",
        previous: {
          kind: "blob",
          mode: "100644",
        },
        current: {
          kind: "blob",
          mode: "100644",
        },
        source: {
          kind: "move",
          path: "a.txt",
        },
        changes: {
          kindChanged: false,
          modeChanged: false,
          contentChanged: true,
        },
      },
    ]);
  });

  test("删除 move 目标仍保持全量语义正确", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]),
    });

    session.move("a.txt", "b.txt");
    session.delete("b.txt");

    expect(session.diff()).toMatchObject([
      {
        kind: "remove",
        path: "a.txt",
        previous: {
          kind: "blob",
          mode: "100644",
        },
      },
    ]);
  });

  test("源不存在抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    expect(() => session.move("noexist", "dest")).toThrow(VirtualPathNotFoundError);
  });

  test("目标已存在抛 VirtualPathAlreadyExistsError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("a.txt", Buffer.from("a"));
    session.writeFile("b.txt", Buffer.from("b"));
    expect(() => session.move("a.txt", "b.txt")).toThrow(VirtualPathAlreadyExistsError);
  });

  test("move 到自身为无操作", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("f.txt", Buffer.from("data"));
    session.move("f.txt", "f.txt");
    expect(session.exists("f.txt")).toBe(true);
    expect(session.readFile("f.txt").toString()).toBe("data");
    expect(session.diff()).toMatchObject([
      {
        kind: "create",
        path: "f.txt",
        current: {
          kind: "blob",
          mode: "100644",
        },
      },
    ]);
  });

  test("纯新增文件 move 后变更记录不膨胀", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.writeFile("a.txt", Buffer.from("data"));
    session.move("a.txt", "b.txt");
    session.move("b.txt", "c.txt");

    expect(store.listChangeRecords()).toHaveLength(1);
    expect(session.diff()).toMatchObject([
      {
        kind: "create",
        path: "c.txt",
        current: {
          kind: "blob",
          mode: "100644",
        },
      },
    ]);
  });
});

// ==================== copy ====================

describe("copy", () => {
  test("共享同一个 origin blob hash 的兄弟路径在 copy 后仍互不串改", () => {
    const repo = createMemoryRepository();
    const sharedBlobHash = repo.writeBlob(Buffer.from("shared"));
    const baseTree = repo.createTree([
      { mode: "100644", name: "a.txt", hash: sharedBlobHash },
      { mode: "100644", name: "b.txt", hash: sharedBlobHash },
    ]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.copy("a.txt", "a-copy.txt");
    session.writeFile("a-copy.txt", Buffer.from("copy-only"));

    expect(session.readFile("a.txt").toString()).toBe("shared");
    expect(session.readFile("b.txt").toString()).toBe("shared");
    expect(session.readFile("a-copy.txt").toString()).toBe("copy-only");
  });

  test("目标父路径是文件时 copy 抛 VirtualNotDirectoryError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("from.txt", Buffer.from("data"));
    session.writeFile("target", Buffer.from("blocking parent"));

    expect(() => session.copy("from.txt", "target/child.txt")).toThrow(VirtualNotDirectoryError);
  });

  test("复制目录到自己的子目录会保留源目录可读", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("src");
    session.writeFile("src/main.ts", Buffer.from("code"));

    session.copy("src", "src/nested");

    expect(session.readFile("src/main.ts").toString()).toBe("code");
    expect(session.readFile("src/nested/main.ts").toString()).toBe("code");
  });

  test("复制文件", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("a.txt", Buffer.from("data"));
    session.copy("a.txt", "b.txt");

    expect(session.exists("a.txt")).toBe(true);
    expect(session.exists("b.txt")).toBe(true);
    expect(session.readFile("a.txt").toString()).toBe("data");
    expect(session.readFile("b.txt").toString()).toBe("data");
  });

  test("复制 repo-backed 文件", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("repo data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.copy("f", "f_copy");

    expect(session.exists("f")).toBe(true);
    expect(session.exists("f_copy")).toBe(true);
    expect(session.readFile("f_copy").toString()).toBe("repo data");
  });

  test("复制后源和目标可独立修改", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("a.txt", Buffer.from("original"));
    session.copy("a.txt", "b.txt");
    session.writeFile("a.txt", Buffer.from("modified"));

    expect(session.readFile("a.txt").toString()).toBe("modified");
    expect(session.readFile("b.txt").toString()).toBe("original");
  });

  test("复制目录（浅复制）", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("src");
    session.writeFile("src/main.ts", Buffer.from("code"));
    session.copy("src", "src_copy");

    expect(session.exists("src")).toBe(true);
    expect(session.exists("src_copy")).toBe(true);
    // 子项应可读取（懒加载）
    expect(session.readFile("src_copy/main.ts").toString()).toBe("code");
  });

  test("复制后 writeTree 验证导出正确", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("a.txt", Buffer.from("data"));
    session.copy("a.txt", "b.txt");
    const tree = session.writeTree();

    const treeObj = readTree(repo, tree);
    const names = treeObj.entries.map((e) => e.name).sort();
    expect(names).toEqual(["a.txt", "b.txt"]);
  });

  test("repo-backed copy 产出 copy diff", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]),
    });

    session.copy("a.txt", "b.txt");
    expect(session.diff()).toMatchObject([
      {
        kind: "create",
        path: "b.txt",
        current: {
          kind: "blob",
          mode: "100644",
        },
        source: {
          kind: "copy",
          path: "a.txt",
        },
      },
    ]);
  });

  test("workdir-only copy 退化为 create 且不膨胀记录", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.writeFile("a.txt", Buffer.from("data"));
    session.copy("a.txt", "b.txt");

    expect(store.listChangeRecords()).toHaveLength(2);
    expect(session.diff()).toMatchObject([
      {
        kind: "create",
        path: "a.txt",
      },
      {
        kind: "create",
        path: "b.txt",
      },
    ]);
    const copyEntry = session.diff()[1];
    expect(copyEntry?.kind).toBe("create");
    if (copyEntry?.kind === "create") {
      expect(copyEntry.source).toBeUndefined();
    }
  });

  test("源不存在抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    expect(() => session.copy("noexist", "dest")).toThrow(VirtualPathNotFoundError);
  });

  test("目标已存在抛 VirtualPathAlreadyExistsError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("a.txt", Buffer.from("a"));
    session.writeFile("b.txt", Buffer.from("b"));
    expect(() => session.copy("a.txt", "b.txt")).toThrow(VirtualPathAlreadyExistsError);
  });

  test("copy 到自身抛 VirtualPathAlreadyExistsError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("f.txt", Buffer.from("data"));
    expect(() => session.copy("f.txt", "f.txt")).toThrow(VirtualPathAlreadyExistsError);
  });
});

// ==================== revert / reset ====================

describe("revert", () => {
  test("共享同一个 origin blob hash 的不同路径中 revert 只恢复目标路径", () => {
    const repo = createMemoryRepository();
    const sharedBlobHash = repo.writeBlob(Buffer.from("shared"));
    const baseTree = repo.createTree([
      { mode: "100644", name: "a.txt", hash: sharedBlobHash },
      { mode: "100644", name: "b.txt", hash: sharedBlobHash },
    ]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("a.txt", Buffer.from("edited-a"));
    session.writeFile("b.txt", Buffer.from("edited-b"));

    session.revert("a.txt");

    expect(session.readFile("a.txt").toString()).toBe("shared");
    expect(session.readFile("b.txt").toString()).toBe("edited-b");
  });

  test("revert 根路径抛错误", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    expect(() => session.revert("")).toThrow(/Path must not be empty/);
  });

  test("恢复 repo-backed 文件内容", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("old"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("f", Buffer.from("new"));
    expect(session.readFile("f").toString()).toBe("new");

    session.revert("f");
    expect(session.readFile("f").toString()).toBe("old");
    expect(session.diff()).toEqual([]);
  });

  test("重复修改后 revert 会清空单路径变更记录", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("old"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.writeFile("f", Buffer.from("v1"));
    session.writeFile("f", Buffer.from("v2"));
    expect(store.listChangeRecords()).toHaveLength(1);

    session.revert("f");
    expect(store.listChangeRecords()).toEqual([]);
    expect(session.diff()).toEqual([]);
    expect(session.readFile("f").toString()).toBe("old");
  });

  test("恢复 repo-backed 符号链接目标", () => {
    const repo = createMemoryRepository();
    const linkHash = repo.writeBlob(Buffer.from("old-target"));
    const baseTree = repo.createTree([{ mode: "120000", name: "link", hash: linkHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeLink("link", "new-target");
    session.revert("link");

    expect(session.readLink("link")).toBe("old-target");
  });

  test("恢复 copy 出来的 repo-backed 文件（未 materialize）为 no-op", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("repo data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.copy("f", "f-copy");
    session.revert("f-copy");

    expect(session.readFile("f-copy").toString()).toBe("repo data");
  });

  test("恢复 copy 出来的 repo-backed 文件（已 materialize）", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("repo data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.copy("f", "f-copy");
    session.writeFile("f-copy", Buffer.from("edited"));
    session.revert("f-copy");

    expect(session.readFile("f-copy").toString()).toBe("repo data");
  });

  test("恢复目录 overlay 到 origin", () => {
    const repo = createMemoryRepository();
    const childHash = repo.writeBlob(Buffer.from("base"));
    const dirHash = repo.createTree([{ mode: "100644", name: "base.txt", hash: childHash }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: dirHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("dir/new.txt", Buffer.from("new"));
    expect(session.readdir("dir").map((entry) => entry.name)).toEqual(["base.txt", "new.txt"]);

    session.revert("dir");
    expect(session.readdir("dir").map((entry) => entry.name)).toEqual(["base.txt"]);
  });

  test("恢复目录 overlay 后新增子路径不可见", () => {
    const repo = createMemoryRepository();
    const childHash = repo.writeBlob(Buffer.from("base"));
    const dirHash = repo.createTree([{ mode: "100644", name: "base.txt", hash: childHash }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "dir", hash: dirHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("dir/new.txt", Buffer.from("new"));
    session.revert("dir");

    expect(session.exists("dir/new.txt")).toBe(false);
    expect(() => session.readFile("dir/new.txt")).toThrow(VirtualPathNotFoundError);
  });

  test("恢复纯新建节点抛 VirtualRevertNotSupportedError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("fresh.txt", Buffer.from("data"));
    expect(() => session.revert("fresh.txt")).toThrow(VirtualRevertNotSupportedError);
  });

  test("恢复不存在路径抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    expect(() => session.revert("missing.txt")).toThrow(VirtualPathNotFoundError);
  });
});

describe("reset", () => {
  test("丢弃 overlay 与 diff，并切换到新 baseTree", () => {
    const repo = createMemoryRepository();
    const oldBaseTree = repo.createTree([]);
    const resetBlobHash = repo.writeBlob(Buffer.from("reset"));
    const newBaseTree = repo.createTree([
      { mode: "100644", name: "after.txt", hash: resetBlobHash },
    ]);
    const session = createVirtualWorkdir(repo.objects, { baseTree: oldBaseTree });

    session.writeFile("before.txt", Buffer.from("before"));
    session.mkdir("dir");
    expect(session.diff().length).toBeGreaterThan(0);

    session.reset(newBaseTree);

    expect(session.baseTree).toBe(newBaseTree);
    expect(session.exists("before.txt")).toBe(false);
    expect(session.exists("dir")).toBe(false);
    expect(session.readFile("after.txt").toString()).toBe("reset");
    expect(session.diff()).toEqual([]);
  });

  test("reset 后行为等同新 workdir", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree: repo.createTree([]) });

    session.writeFile("temp.txt", Buffer.from("temp"));
    session.reset(baseTree);

    const fresh = createVirtualWorkdir(repo.objects, { baseTree });
    expect(session.readdir()).toEqual(fresh.readdir());
    expect(session.readFile("f").toString()).toBe(fresh.readFile("f").toString());
  });

  test("reset 后 diff 为空（替代旧版 dirty dir summaries 清空测试）", () => {
    const repo = createMemoryRepository();
    const oldBaseTree = repo.createTree([]);
    const newBaseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(oldBaseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.mkdir("dir");
    session.writeFile("dir/file.txt", Buffer.from("data"));
    expect(session.diff().length).toBeGreaterThan(0);

    session.reset(newBaseTree);
    expect(session.diff()).toEqual([]);
  });

  test("新增后再删除 diff 会正确收敛", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.mkdir("src");
    session.writeFile("src/a.ts", Buffer.from("a1"));
    expect(session.diff().length).toBeGreaterThan(0);

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

  test("删除目录后同名写文件时 writeTree 不保留旧子文件", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.mkdir("manuscript");
    session.writeFile("manuscript/a.md", Buffer.from("a"));
    session.delete("manuscript", { force: true });
    session.writeFile("manuscript", Buffer.from("file-now"));

    const treeHash = session.writeTree();
    const root = readTree(repo, treeHash);
    expect(root.entries).toHaveLength(1);
    expect(root.entries[0]).toMatchObject({ mode: "100644", name: "manuscript" });
    expect(readBlob(repo, root.entries[0]!.hash).toString()).toBe("file-now");
  });

  test("repo-backed 文件 revert 到 clean 后 diff 为空", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const srcTree = repo.createTree([{ mode: "100644", name: "a.ts", hash: blobHash }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: srcTree }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.writeFile("src/a.ts", Buffer.from("next"));
    expect(session.diff().length).toBeGreaterThan(0);

    session.revert("src/a.ts");
    expect(session.diff()).toEqual([]);
  });

  test("多次写入后 writeTree 产出正确的 tree 结构", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.mkdir("src");
    session.writeFile("src/a.ts", Buffer.from("a1"));
    session.writeFile("src/b.ts", Buffer.from("b1"));
    session.writeFile("src/a.ts", Buffer.from("a2"));

    const treeHash = session.writeTree();
    const root = repo.catFile(treeHash) as GitTree;
    expect(root.type).toBe("tree");
    expect(root.entries).toHaveLength(1);
    expect(root.entries[0]?.name).toBe("src");
    const src = repo.catFile(root.entries[0]!.hash) as GitTree;
    expect(src.type).toBe("tree");
    expect(src.entries).toHaveLength(2);
    const aEntry = src.entries.find((e) => e.name === "a.ts");
    const bEntry = src.entries.find((e) => e.name === "b.ts");
    expect(aEntry).toBeDefined();
    expect(bEntry).toBeDefined();
  });
});
