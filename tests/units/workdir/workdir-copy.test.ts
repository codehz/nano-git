/**
 * workdir/workdir.ts copy 操作单元测试
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

  test("workdir-only copy 产出 create 且不膨胀记录", () => {
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
});
