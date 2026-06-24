/**
 * workdir/session.ts 写入操作单元测试（Phase 4）
 */
import { describe, test, expect } from "bun:test";

import {
  VirtualNotDirectoryError,
  VirtualNotFileError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
} from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdirSession } from "@/workdir/session.ts";

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

// ==================== mkdir ====================

describe("mkdir", () => {
  test("根下新建目录", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const session = createVirtualWorkdirSession(repo.objects, { baseTree });

    session.mkdir("src");
    expect(session.exists("src")).toBe(true);
    expect(session.stat("src")).toMatchObject({ kind: "tree", mode: "40000" });
    expect(session.readdir()).toEqual([{ name: "src", kind: "tree", mode: "40000" }]);
    expect(session.readdir("src")).toEqual([]);
  });

  test("嵌套目录", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const session = createVirtualWorkdirSession(repo.objects, { baseTree });

    session.mkdir("a");
    session.mkdir("a/b");
    session.mkdir("a/b/c");

    expect(session.exists("a/b/c")).toBe(true);
    expect(session.stat("a/b/c")).toMatchObject({ kind: "tree" });
    expect(session.readdir("a/b")).toEqual([{ name: "c", kind: "tree", mode: "40000" }]);
  });

  test("父目录不存在时抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdirSession(repo.objects, {
      baseTree: repo.createTree([]),
    });
    expect(() => session.mkdir("no/such")).toThrow(VirtualPathNotFoundError);
  });

  test("重复创建抛 VirtualPathAlreadyExistsError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdirSession(repo.objects, {
      baseTree: repo.createTree([]),
    });
    session.mkdir("x");
    expect(() => session.mkdir("x")).toThrow(VirtualPathAlreadyExistsError);
  });

  test("在文件下创建目录抛 VirtualNotDirectoryError", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdirSession(repo.objects, { baseTree });
    expect(() => session.mkdir("f/sub")).toThrow(VirtualNotDirectoryError);
  });
});

// ==================== writeFile ====================

describe("writeFile", () => {
  test("新建文件并读取", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdirSession(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("hello.txt", Buffer.from("Hello World"));
    expect(session.exists("hello.txt")).toBe(true);
    expect(session.readFile("hello.txt").toString()).toBe("Hello World");
    expect(session.stat("hello.txt")).toMatchObject({ kind: "blob", mode: "100644", size: 11 });
  });

  test("新建可执行文件 mode 100755", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdirSession(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("run.sh", Buffer.from("#!/bin/sh"), { mode: "100755" });
    expect(session.stat("run.sh")).toMatchObject({ kind: "blob", mode: "100755" });
  });

  test("覆盖已有文件", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("old"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdirSession(repo.objects, { baseTree });

    expect(session.readFile("f").toString()).toBe("old");
    session.writeFile("f", Buffer.from("new content"));
    expect(session.readFile("f").toString()).toBe("new content");
  });

  test("在目录路径上写文件抛 VirtualNotFileError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdirSession(repo.objects, {
      baseTree: repo.createTree([]),
    });
    session.mkdir("dir");
    expect(() => session.writeFile("dir", Buffer.from("x"))).toThrow(VirtualNotFileError);
  });

  test("父目录不存在抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdirSession(repo.objects, {
      baseTree: repo.createTree([]),
    });
    expect(() => session.writeFile("no/such.txt", Buffer.from("x"))).toThrow(
      VirtualPathNotFoundError,
    );
  });

  test("嵌套路径下写文件", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdirSession(repo.objects, {
      baseTree: repo.createTree([]),
    });
    session.mkdir("a");
    session.mkdir("a/b");
    session.writeFile("a/b/f.txt", Buffer.from("deep"));
    expect(session.readFile("a/b/f.txt").toString()).toBe("deep");
  });
});

// ==================== writeLink ====================

describe("writeLink", () => {
  test("新建符号链接并读取", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdirSession(repo.objects, {
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
    const session = createVirtualWorkdirSession(repo.objects, { baseTree });

    expect(session.readLink("l")).toBe("old-target");
    session.writeLink("l", "new-target");
    expect(session.readLink("l")).toBe("new-target");
  });

  test("在目录上写符号链接抛 VirtualNotFileError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdirSession(repo.objects, {
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
    const session = createVirtualWorkdirSession(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("f.txt", Buffer.from("data"));
    expect(session.exists("f.txt")).toBe(true);
    session.delete("f.txt");
    expect(session.exists("f.txt")).toBe(false);
  });

  test("删除新建目录", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdirSession(repo.objects, {
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
    const session = createVirtualWorkdirSession(repo.objects, { baseTree });

    expect(session.exists("f")).toBe(true);
    session.delete("f");
    expect(session.exists("f")).toBe(false);
  });

  test("删除不存在的路径抛 VirtualPathNotFoundError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdirSession(repo.objects, {
      baseTree: repo.createTree([]),
    });
    expect(() => session.delete("no/such")).toThrow(VirtualPathNotFoundError);
  });
});

// ==================== writeTree ====================

describe("writeTree", () => {
  test("空 session writeTree 返回 baseTree", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const session = createVirtualWorkdirSession(repo.objects, { baseTree });

    expect(session.writeTree()).toBe(baseTree);
  });

  test("新建单文件后 writeTree", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const session = createVirtualWorkdirSession(repo.objects, { baseTree });

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
    const session = createVirtualWorkdirSession(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("f.txt", Buffer.from("data"));
    session.writeTree();
    // 继续读取（overlay 未清空）
    expect(session.readFile("f.txt").toString()).toBe("data");
  });

  test("连续多次 writeTree 结果可重复", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdirSession(repo.objects, {
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
    const session = createVirtualWorkdirSession(repo.objects, { baseTree });

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
    const session = createVirtualWorkdirSession(repo.objects, {
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
    expect(srcEntry.mode).toBe("40000");
    const srcTree = readTree(repo, srcEntry.hash);
    const srcNames = srcTree.entries.map((e) => e.name).sort();
    expect(srcNames).toEqual(["lib.ts", "main.ts"]);
  });

  test("writeTree 后 baseTree 不变", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const session = createVirtualWorkdirSession(repo.objects, { baseTree });

    session.writeFile("f.txt", Buffer.from("data"));
    session.writeTree();
    expect(session.baseTree).toBe(baseTree);
  });

  test("新建空目录后 writeTree", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdirSession(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("empty");
    const newTree = session.writeTree();
    const tree = readTree(repo, newTree);
    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]!.name).toBe("empty");
    expect(tree.entries[0]!.mode).toBe("40000");
  });

  test("writeTree 后通过新 session 读取验证", () => {
    const repo = createMemoryRepository();
    const session1 = createVirtualWorkdirSession(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session1.writeFile("a.txt", Buffer.from("alpha"));
    session1.writeFile("b.txt", Buffer.from("beta"));
    const hash = session1.writeTree();

    // 用新的 session 打开导出 tree
    const session2 = createVirtualWorkdirSession(repo.objects, { baseTree: hash });
    expect(session2.readdir().length).toBe(2);
    expect(session2.readFile("a.txt").toString()).toBe("alpha");
    expect(session2.readFile("b.txt").toString()).toBe("beta");
  });
});

// ==================== listChanges ====================

describe("listChanges（写入操作）", () => {
  test("新建文件记录 add", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdirSession(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("f.txt", Buffer.from("data"));
    const changes = session.listChanges();
    expect(changes).toEqual([{ path: "f.txt", type: "add" }]);
  });

  test("修改文件记录 modify", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("old"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdirSession(repo.objects, { baseTree });

    session.writeFile("f", Buffer.from("new"));
    const changes = session.listChanges();
    expect(changes).toEqual([{ path: "f", type: "modify" }]);
  });

  test("删除文件记录 delete", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const baseTree = repo.createTree([{ mode: "100644", name: "f", hash: blobHash }]);
    const session = createVirtualWorkdirSession(repo.objects, { baseTree });

    session.delete("f");
    const changes = session.listChanges();
    expect(changes).toEqual([{ path: "f", type: "delete" }]);
  });

  test("新建目录记录 add", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdirSession(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.mkdir("dir");
    expect(session.listChanges()).toEqual([{ path: "dir", type: "add" }]);
  });
});
