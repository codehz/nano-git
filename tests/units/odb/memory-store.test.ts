/**
 * 内存对象存储单元测试
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { sha1 } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/index.ts";

import type { GitBlob, GitTree, GitCommit, GitAuthor } from "@/core/types.ts";

const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

describe("createMemoryObjectStore()", () => {
  let store: ReturnType<typeof createMemoryObjectStore>;

  beforeEach(() => {
    store = createMemoryObjectStore();
  });

  test("写入并读取 blob 对象", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("hello world"),
    };
    const hash = store.write(blob);
    expect(hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));

    const read = store.read(hash);
    expect(read.type).toBe("blob");
    if (read.type === "blob") {
      expect(read.content.toString("utf-8")).toBe("hello world");
    }
  });

  test("写入并读取 tree 对象", () => {
    const blobHash = store.write({
      type: "blob",
      content: Buffer.from("content"),
    });

    const tree: GitTree = {
      type: "tree",
      entries: [{ mode: "100644", name: "file.txt", hash: blobHash }],
    };
    const treeHash = store.write(tree);

    const read = store.read(treeHash);
    expect(read.type).toBe("tree");
    if (read.type === "tree") {
      expect(read.entries).toHaveLength(1);
      expect(read.entries[0]!.name).toBe("file.txt");
      expect(read.entries[0]!.hash).toBe(blobHash);
    }
  });

  test("写入并读取 commit 对象", () => {
    const treeHash = store.write({ type: "tree", entries: [] });
    const commit: GitCommit = {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: testAuthor,
      committer: testAuthor,
      message: "Initial commit",
    };
    const commitHash = store.write(commit);

    const read = store.read(commitHash);
    expect(read.type).toBe("commit");
    if (read.type === "commit") {
      expect(read.tree).toBe(treeHash);
      expect(read.message).toBe("Initial commit");
    }
  });

  test("相同内容只存储一次（内容寻址）", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("duplicate"),
    };
    const hash1 = store.write(blob);
    const hash2 = store.write(blob);
    expect(hash1).toBe(hash2);
    expect(store.list()).toHaveLength(1);
  });

  test("exists() 正确判断对象是否存在", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("test"),
    };
    const hash = store.write(blob);
    expect(store.exists(hash)).toBe(true);
    expect(store.exists(sha1("0000000000000000000000000000000000000000"))).toBe(false);
  });

  test("读取不存在的对象应抛出异常", () => {
    const fakeHash = sha1("0000000000000000000000000000000000000000");
    expect(() => store.read(fakeHash)).toThrow("Object not found");
  });

  test("list() 返回所有存储的哈希", () => {
    expect(store.list()).toHaveLength(0);

    const hash1 = store.write({ type: "blob", content: Buffer.from("a") });
    const hash2 = store.write({ type: "blob", content: Buffer.from("b") });

    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list).toContain(hash1);
    expect(list).toContain(hash2);
  });
});
