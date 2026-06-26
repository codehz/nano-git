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

  test("repo-backed copy 产出 create diff", () => {
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
      },
    ]);
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

  test("copy 到自身抛 VirtualPathAlreadyExistsError", () => {
    const repo = createMemoryRepository();
    const session = createVirtualWorkdir(repo.objects, {
      baseTree: repo.createTree([]),
    });

    session.writeFile("f.txt", Buffer.from("data"));
    expect(() => session.copy("f.txt", "f.txt")).toThrow(VirtualPathAlreadyExistsError);
  });
});
