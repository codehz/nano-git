/**
 * workdir/workdir.ts move 操作单元测试
 */
import { describe, test, expect } from "bun:test";

import {
  VirtualNotDirectoryError,
  VirtualPathAlreadyExistsError,
  VirtualPathNotFoundError,
} from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdirMemoryStateStore } from "@/workdir/memory-backend.ts";
import { createVirtualWorkdir, openVirtualWorkdir } from "@/workdir/workdir.ts";

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

  test("move 空目录产出 remove + create diff", () => {
    const repo = createMemoryRepository();
    const emptyTree = repo.createTree([]);
    const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: emptyTree }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.move("src", "lib");

    expect(session.diff()).toMatchObject([
      {
        kind: "create",
        path: "lib",
        current: {
          kind: "tree",
          mode: "040000",
          hash: emptyTree,
        },
      },
      {
        kind: "remove",
        path: "src",
        previous: {
          kind: "tree",
          mode: "040000",
          hash: emptyTree,
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

  test("repo-backed move 产出 remove + create diff", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]),
    });

    session.move("a.txt", "b.txt");
    const diff = session.diff();
    expect(diff.find((entry) => entry.path === "a.txt")).toMatchObject({
      kind: "remove",
      path: "a.txt",
      previous: {
        kind: "blob",
        mode: "100644",
      },
    });
    expect(diff.find((entry) => entry.path === "b.txt")).toMatchObject({
      kind: "create",
      path: "b.txt",
      current: {
        kind: "blob",
        mode: "100644",
      },
    });
  });

  test("move 后修改内容仍表现为 remove + create", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("data"));
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]),
    });

    session.move("a.txt", "b.txt");
    session.writeFile("b.txt", Buffer.from("changed"));

    const diff = session.diff();
    expect(diff.find((entry) => entry.path === "a.txt")).toMatchObject({
      kind: "remove",
      path: "a.txt",
      previous: {
        kind: "blob",
        mode: "100644",
      },
    });
    expect(diff.find((entry) => entry.path === "b.txt")).toMatchObject({
      kind: "create",
      path: "b.txt",
      current: {
        kind: "blob",
        mode: "100644",
      },
    });
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
