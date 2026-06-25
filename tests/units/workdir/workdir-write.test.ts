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

  test("仅新建目录时不输出目录 diff", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("dir");
    expect(session.diff()).toEqual([]);
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

// ==================== rename ====================

describe("rename", () => {
  test("同目录下重命名文件", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("old.txt", Buffer.from("content"));
    session.rename("old.txt", "new.txt");

    expect(session.exists("old.txt")).toBe(false);
    expect(session.exists("new.txt")).toBe(true);
    expect(session.readFile("new.txt").toString()).toBe("content");
  });

  test("跨目录重命名文件", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("a.txt", Buffer.from("moved"));
    session.mkdir("sub");
    session.rename("a.txt", "sub/b.txt");

    expect(session.exists("a.txt")).toBe(false);
    expect(session.exists("sub/b.txt")).toBe(true);
    expect(session.readFile("sub/b.txt").toString()).toBe("moved");
  });

  test("重命名 repo-backed 文件", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("repo data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.rename("f", "g");
    expect(session.exists("f")).toBe(false);
    expect(session.exists("g")).toBe(true);
    expect(session.readFile("g").toString()).toBe("repo data");
  });

  test("重命名目录", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("src");
    session.writeFile("src/main.ts", Buffer.from("code"));
    session.rename("src", "lib");

    expect(session.exists("src")).toBe(false);
    expect(session.exists("lib")).toBe(true);
    expect(session.readFile("lib/main.ts").toString()).toBe("code");
  });

  test("重命名后 writeTree 不制造额外 blob", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("old.txt", Buffer.from("content"));
    session.rename("old.txt", "new.txt");
    const tree = session.writeTree();

    const treeObj = readTree(repo, tree);
    expect(treeObj.entries).toHaveLength(1);
    expect(treeObj.entries[0]!.name).toBe("new.txt");
    expect(readBlob(repo, treeObj.entries[0]!.hash).toString()).toBe("content");
  });

  test("repo-backed rename 产出 rename diff", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]),
    });

    session.rename("a.txt", "b.txt");
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
          kind: "rename",
          path: "a.txt",
        },
      },
    ]);
  });

  test("rename 后修改内容仍保留 rename 来源", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]),
    });

    session.rename("a.txt", "b.txt");
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
          kind: "rename",
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

  test("删除 rename 目标仍保持全量语义正确", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]),
    });

    session.rename("a.txt", "b.txt");
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

    expect(() => session.rename("noexist", "dest")).toThrow(VirtualPathNotFoundError);
  });

  test("目标已存在抛 VirtualPathAlreadyExistsError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("a.txt", Buffer.from("a"));
    session.writeFile("b.txt", Buffer.from("b"));
    expect(() => session.rename("a.txt", "b.txt")).toThrow(VirtualPathAlreadyExistsError);
  });

  test("rename 到自身为无操作", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("f.txt", Buffer.from("data"));
    session.rename("f.txt", "f.txt");
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

  test("纯新增文件 rename 后变更记录不膨胀", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.writeFile("a.txt", Buffer.from("data"));
    session.rename("a.txt", "b.txt");
    session.rename("b.txt", "c.txt");

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

  test("reset 会清空 dirty dir summaries", () => {
    const repo = createMemoryRepository();
    const oldBaseTree = repo.createTree([]);
    const newBaseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(oldBaseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.mkdir("dir");
    session.writeFile("dir/file.txt", Buffer.from("data"));
    expect(store.listDirtyDirSummaries().length).toBeGreaterThan(0);

    session.reset(newBaseTree);
    expect(store.listDirtyDirSummaries()).toEqual([]);
  });

  test("新增后再删除会收敛并清空 dirty dir summaries", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.mkdir("src");
    session.writeFile("src/a.ts", Buffer.from("a1"));
    expect(store.listDirtyDirSummaries().length).toBeGreaterThan(0);

    session.delete("src/a.ts");
    expect(store.listDirtyDirSummaries()).toEqual([
      {
        path: "",
        isDirty: true,
        dirtyEntryCount: 1,
        dirtyDescendantCount: 0,
        affectedNames: ["src"],
        currentTreeHash: null,
        hashState: "stale",
      },
    ]);
  });

  test("repo-backed 文件 revert 到 clean 后会清空 dirty dir summaries", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const srcTree = repo.createTree([{ mode: "100644", name: "a.ts", hash: blobHash }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: srcTree }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.writeFile("src/a.ts", Buffer.from("next"));
    expect(store.getDirtyDirSummary("")).toEqual({
      path: "",
      isDirty: true,
      dirtyEntryCount: 1,
      dirtyDescendantCount: 1,
      affectedNames: ["src"],
      currentTreeHash: null,
      hashState: "stale",
    });

    session.revert("src/a.ts");
    expect(store.listDirtyDirSummaries()).toEqual([]);
  });

  test("dirty dir summaries 会累积 affectedNames 并在后续写入时保持去重", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.mkdir("src");
    session.writeFile("src/a.ts", Buffer.from("a1"));
    session.writeFile("src/b.ts", Buffer.from("b1"));
    session.writeFile("src/a.ts", Buffer.from("a2"));

    expect(store.getDirtyDirSummary("")).toEqual({
      path: "",
      isDirty: true,
      dirtyEntryCount: 1,
      dirtyDescendantCount: 2,
      affectedNames: ["src"],
      currentTreeHash: null,
      hashState: "stale",
    });
    expect(store.getDirtyDirSummary("src")).toEqual({
      path: "src",
      isDirty: true,
      dirtyEntryCount: 2,
      dirtyDescendantCount: 0,
      affectedNames: ["a.ts", "b.ts"],
      currentTreeHash: null,
      hashState: "stale",
    });
  });
});
