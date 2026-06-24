/**
 * workdir/write-tree.ts 语义测试
 */
import { describe, test, expect } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdirSession } from "@/workdir/session.ts";

import type { GitTree } from "@/core/types.ts";
import type { Repository } from "@/repository/types.ts";

function readTree(repo: Repository, hash: string): GitTree {
  const obj = repo.catFile(hash as import("@/core/types.ts").SHA1);
  if (obj.type !== "tree") {
    throw new Error(`Expected tree, got ${obj.type}`);
  }
  return obj;
}

describe("writeTree object reuse", () => {
  test("修改兄弟文件时复用未改动子树 hash", () => {
    const repo = createMemoryRepository();
    const nestedHash = repo.writeBlob(Buffer.from("nested"));
    const subTreeHash = repo.createTree([{ mode: "100644", name: "child.txt", hash: nestedHash }]);
    const rootBlobHash = repo.writeBlob(Buffer.from("root"));
    const baseTree = repo.createTree([
      { mode: "40000", name: "dir", hash: subTreeHash },
      { mode: "100644", name: "root.txt", hash: rootBlobHash },
    ]);
    const session = createVirtualWorkdirSession(repo.objects, { baseTree });

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
    const session = createVirtualWorkdirSession(repo.objects, { baseTree });

    session.copy("a.txt", "b.txt");
    const nextTree = session.writeTree();
    const root = readTree(repo, nextTree);
    const hashes = root.entries.map((entry) => entry.hash);

    expect(hashes).toEqual([blobHash, blobHash]);
  });
});
