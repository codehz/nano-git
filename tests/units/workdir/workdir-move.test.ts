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
