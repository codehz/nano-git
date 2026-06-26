/**
 * workdir/workdir.ts diff 操作单元测试
 */
import { describe, test, expect } from "bun:test";

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

describe("diff（写入操作）", () => {
  test("新建文件产出 create", () => {
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

  test("修改文件产出 update", () => {
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
