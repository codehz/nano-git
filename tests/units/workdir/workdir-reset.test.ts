/**
 * workdir/workdir.ts reset 操作单元测试
 *
 * 注意：最后一个测试虽然位于 reset describe 内，
 * 但实际测试的是 writeTree 语义。保留在此避免历史变动影响。
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
