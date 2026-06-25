/**
 * workdir/write-tree.ts 语义测试
 */
import { describe, test, expect } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import { originBackedNodeId } from "@/workdir/ids.ts";
import { createVirtualWorkdirMemoryStateStore } from "@/workdir/memory-backend.ts";
import { createVirtualWorkdir } from "@/workdir/workdir.ts";
import { openVirtualWorkdir } from "@/workdir/workdir.ts";

import type { GitTree } from "@/core/types.ts";
import type { ObjectDatabase } from "@/core/types/odb.ts";
import type { Repository } from "@/repository/types.ts";

function readTree(repo: Repository, hash: string): GitTree {
  const obj = repo.catFile(hash as import("@/core/types.ts").SHA1);
  if (obj.type !== "tree") {
    throw new Error(`Expected tree, got ${obj.type}`);
  }
  return obj;
}

function createCountingObjectDatabase(source: ObjectDatabase): {
  readonly objects: ObjectDatabase;
  getIngestCount(): number;
} {
  let ingestCount = 0;

  return {
    objects: {
      read(hash) {
        return source.read(hash);
      },
      tryRead(hash) {
        return source.tryRead(hash);
      },
      exists(hash) {
        return source.exists(hash);
      },
      list() {
        return source.list();
      },
      ingest(raw) {
        ingestCount += 1;
        source.ingest(raw);
      },
      ingestMany(objects) {
        for (const raw of objects) {
          ingestCount += 1;
          source.ingest(raw);
        }
      },
      delete(hash) {
        source.delete(hash);
      },
    },
    getIngestCount() {
      return ingestCount;
    },
  };
}

describe("writeTree object reuse", () => {
  test("修改兄弟文件时复用未改动子树 hash", () => {
    const repo = createMemoryRepository();
    const nestedHash = repo.writeBlob(Buffer.from("nested"));
    const subTreeHash = repo.createTree([{ mode: "100644", name: "child.txt", hash: nestedHash }]);
    const rootBlobHash = repo.writeBlob(Buffer.from("root"));
    const baseTree = repo.createTree([
      { mode: "040000", name: "dir", hash: subTreeHash },
      { mode: "100644", name: "root.txt", hash: rootBlobHash },
    ]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.writeFile("root.txt", Buffer.from("changed"));
    const nextTree = session.writeTree();
    const root = readTree(repo, nextTree);
    const dirEntry = root.entries.find((entry) => entry.name === "dir");

    expect(dirEntry?.hash).toBe(subTreeHash);
  });

  test("复制未 materialize 的 repo-backed 文件时复用同一 blob hash", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("shared"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.copy("a.txt", "b.txt");
    const nextTree = session.writeTree();
    const root = readTree(repo, nextTree);
    const hashes = root.entries.map((entry) => entry.hash);

    expect(hashes).toEqual([blobHash, blobHash]);
  });

  test("dirty summary 允许 writeTree 跳过未脏 repo-backed 子树", () => {
    const repo = createMemoryRepository();
    const leftBlob = repo.writeBlob(Buffer.from("left"));
    const rightBlob = repo.writeBlob(Buffer.from("right"));
    const leftTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: leftBlob }]);
    const rightTree = repo.createTree([{ mode: "100644", name: "b.txt", hash: rightBlob }]);
    const baseTree = repo.createTree([
      { mode: "040000", name: "left", hash: leftTree },
      { mode: "040000", name: "right", hash: rightTree },
    ]);

    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);
    session.writeFile("left/a.txt", Buffer.from("left-2"));

    const nextTree = session.writeTree();
    const root = readTree(repo, nextTree);
    expect(root.entries.find((entry) => entry.name === "right")?.hash).toBe(rightTree);
  });

  test("dirty summary 驱动 repo-backed 目录中的新增条目写出", () => {
    const repo = createMemoryRepository();
    const baseBlob = repo.writeBlob(Buffer.from("base"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: baseBlob }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.writeFile("b.txt", Buffer.from("next"));
    const nextTree = session.writeTree();
    const root = readTree(repo, nextTree);

    expect(root.entries.map((entry) => entry.name)).toEqual(["a.txt", "b.txt"]);
  });

  test("dirty summary 只解析受影响名字，未受影响 origin 子项不被懒注册", () => {
    const repo = createMemoryRepository();
    const leftBlob = repo.writeBlob(Buffer.from("left"));
    const rightBlob = repo.writeBlob(Buffer.from("right"));
    const keepBlob = repo.writeBlob(Buffer.from("keep"));
    const baseTree = repo.createTree([
      { mode: "100644", name: "left.txt", hash: leftBlob },
      { mode: "100644", name: "right.txt", hash: rightBlob },
      { mode: "100644", name: "keep.txt", hash: keepBlob },
    ]);

    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    const rightNodeId = originBackedNodeId(rightBlob);
    const keepNodeId = originBackedNodeId(keepBlob);
    store.deleteNode(rightNodeId);
    store.deleteNode(keepNodeId);

    expect(store.getNode(rightNodeId)).toBeNull();
    expect(store.getNode(keepNodeId)).toBeNull();

    session.writeFile("left.txt", Buffer.from("left-2"));
    store.deleteNode(rightNodeId);
    store.deleteNode(keepNodeId);

    expect(store.getNode(rightNodeId)).toBeNull();
    expect(store.getNode(keepNodeId)).toBeNull();
    session.writeTree();

    expect(store.getNode(rightNodeId)).toBeNull();
    expect(store.getNode(keepNodeId)).toBeNull();
  });

  test("dirty summary 缓存当前 tree hash，重复 writeTree 不重复编译脏子树", () => {
    const repo = createMemoryRepository();
    const baseBlob = repo.writeBlob(Buffer.from("base"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: baseBlob }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const counting = createCountingObjectDatabase(repo.objects);
    const session = openVirtualWorkdir(counting.objects, store);

    session.writeFile("a.txt", Buffer.from("next"));
    const firstTree = session.writeTree();
    const firstIngestCount = counting.getIngestCount();
    const secondTree = session.writeTree();
    const secondIngestCount = counting.getIngestCount();

    expect(secondTree).toBe(firstTree);
    expect(secondIngestCount).toBe(firstIngestCount);
  });

  test("writeTree 会把 dirty summary 的 hashState 推进为 materialized", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.mkdir("src");
    session.writeFile("src/a.ts", Buffer.from("export const a = 1;\n"));
    expect(store.getDirtyDirSummary("src")?.hashState).toBe("stale");
    expect(store.getDirtyDirSummary("src")?.currentTreeHash).toBeNull();

    const treeHash = session.writeTree();
    const rootSummary = store.getDirtyDirSummary("");
    const srcSummary = store.getDirtyDirSummary("src");

    expect(rootSummary?.hashState).toBe("materialized");
    expect(srcSummary?.hashState).toBe("materialized");
    expect(rootSummary?.currentTreeHash).toBe(treeHash);
    expect(srcSummary?.currentTreeHash).not.toBeNull();
    expect(rootSummary?.dirtyEntryCount).toBe(1);
    expect(rootSummary?.dirtyDescendantCount).toBe(1);
    expect(srcSummary?.dirtyEntryCount).toBe(1);
    expect(srcSummary?.dirtyDescendantCount).toBe(0);
    expect(srcSummary?.affectedNames).toEqual(["a.ts"]);
  });

  test("新建空目录在无子级 summary 时仍会写出新 tree", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const session = createVirtualWorkdir(repo.objects, { baseTree });

    session.mkdir("src");
    const nextTree = session.writeTree();
    const root = readTree(repo, nextTree);

    expect(root.entries).toHaveLength(1);
    expect(root.entries[0]?.mode).toBe("040000");
    expect(root.entries[0]?.name).toBe("src");
    expect(readTree(repo, root.entries[0]!.hash).entries).toEqual([]);
  });
});
