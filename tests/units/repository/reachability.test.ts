/**
 * 仓库可达性遍历测试
 */

import { describe, test, expect } from "bun:test";

import { createMemoryObjectStore } from "@/odb/memory.ts";
import { createMemoryRefStore } from "@/refs/memory.ts";
import { listReachableObjects } from "@/repository/reachability.ts";

describe("listReachableObjects", () => {
  test("空仓库应返回空列表", () => {
    const objects = createMemoryObjectStore();
    const refs = createMemoryRefStore();

    const result = listReachableObjects(objects, refs);
    expect(result).toEqual([]);
  });

  test("从 HEAD 和分支可达的对象", () => {
    const objects = createMemoryObjectStore();
    const refs = createMemoryRefStore();

    // 构造对象图：commit → tree → blob
    const blobHash = objects.write({ type: "blob", content: Buffer.from("hello") });

    const treeHash = objects.write({
      type: "tree",
      entries: [{ mode: "100644", name: "hello.txt", hash: blobHash }],
    });

    const commitHash = objects.write({
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "A", email: "a@a", timestamp: 0, timezone: "+0000" },
      committer: { name: "A", email: "a@a", timestamp: 0, timezone: "+0000" },
      message: "msg",
    });

    // 设置 HEAD 和 refs/heads/main 指向 commit
    refs.write("HEAD", "ref: refs/heads/main");
    refs.write("refs/heads/main", commitHash);

    const result = listReachableObjects(objects, refs);
    expect(result).toContain(blobHash);
    expect(result).toContain(treeHash);
    expect(result).toContain(commitHash);
  });

  test("孤立对象不应出现在结果中", () => {
    const objects = createMemoryObjectStore();
    const refs = createMemoryRefStore();

    // 存储一个 blob 但无 refs 指向它
    const orphanHash = objects.write({ type: "blob", content: Buffer.from("orphan") });

    const result = listReachableObjects(objects, refs);
    expect(result).not.toContain(orphanHash);
    expect(result).toEqual([]);
  });

  test("多个分支可达对象合集", () => {
    const objects = createMemoryObjectStore();
    const refs = createMemoryRefStore();

    // 分支 A 的对象
    const blobA = objects.write({ type: "blob", content: Buffer.from("a") });
    const treeA = objects.write({
      type: "tree",
      entries: [{ mode: "100644", name: "a", hash: blobA }],
    });
    const commitA = objects.write({
      type: "commit",
      tree: treeA,
      parents: [],
      author: { name: "A", email: "a@a", timestamp: 0, timezone: "+0000" },
      committer: { name: "A", email: "a@a", timestamp: 0, timezone: "+0000" },
      message: "msg",
    });

    // 分支 B 的对象
    const blobB = objects.write({ type: "blob", content: Buffer.from("b") });
    const treeB = objects.write({
      type: "tree",
      entries: [{ mode: "100644", name: "b", hash: blobB }],
    });
    const commitB = objects.write({
      type: "commit",
      tree: treeB,
      parents: [],
      author: { name: "B", email: "b@b", timestamp: 0, timezone: "+0000" },
      committer: { name: "B", email: "b@b", timestamp: 0, timezone: "+0000" },
      message: "msg",
    });

    refs.write("HEAD", "ref: refs/heads/main");
    refs.write("refs/heads/main", commitA);
    refs.write("refs/heads/feature", commitB);

    const result = listReachableObjects(objects, refs);
    expect(result).toContain(commitA);
    expect(result).toContain(commitB);
    expect(result).toContain(blobA);
    expect(result).toContain(blobB);
  });
});
