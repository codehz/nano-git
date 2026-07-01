/**
 * repository/ops/object-operations.ts 单元测试
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryObjectStore } from "@/odb/memory.ts";
import { createRepositoryFsObjectOperations } from "@/repository/ops/fs-object-operations.ts";
import { createObjectRepositoryOperations } from "@/repository/ops/object-operations.ts";
import { sha1, type GitAuthor } from "@/types/index.ts";

const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

describe("createObjectRepositoryOperations()", () => {
  let ops: ReturnType<typeof createObjectRepositoryOperations>;
  let store: ReturnType<typeof createMemoryObjectStore>;

  beforeEach(() => {
    store = createMemoryObjectStore();
    ops = createObjectRepositoryOperations(store);
  });

  test("hashObject() 计算 blob 哈希但不写入", () => {
    const hash = ops.hashObject(Buffer.from("hello world"));
    expect(hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));
    expect(() => ops.catFile(hash)).toThrow("Object not found");
  });

  test("writeBlob() 写入并返回哈希", () => {
    const hash = ops.writeBlob(Buffer.from("hello world"));
    expect(hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));

    const obj = ops.catFile(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString()).toBe("hello world");
    }
  });

  test("writeBlobFile() 从文件写入 blob", () => {
    const dir = join(tmpdir(), `nano-git-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "test.txt");
    writeFileSync(filePath, "file content");
    try {
      const fsOps = createRepositoryFsObjectOperations(store, (data) => ops.writeBlob(data));
      const hash = fsOps.writeBlobFile(filePath);
      const obj = ops.catFile(hash);
      expect(obj.type).toBe("blob");
      if (obj.type === "blob") {
        expect(obj.content.toString()).toBe("file content");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("catFile() 读取已存在的对象", () => {
    const hash = ops.writeBlob(Buffer.from("data"));
    const obj = ops.catFile(hash);
    expect(obj.type).toBe("blob");
  });

  test("catFile() 读取不存在的对象抛出异常", () => {
    const badHash = sha1("0000000000000000000000000000000000000000");
    expect(() => ops.catFile(badHash)).toThrow();
  });

  test("catFileType() 返回对象类型字符串", () => {
    const h1 = ops.writeBlob(Buffer.from("a"));
    expect(ops.catFileType(h1)).toBe("blob");

    const h2 = ops.createTree([]);
    expect(ops.catFileType(h2)).toBe("tree");
  });

  test("listObjects() 列出所有对象", () => {
    expect(ops.listObjects()).toHaveLength(0);
    ops.writeBlob(Buffer.from("a"));
    ops.writeBlob(Buffer.from("b"));
    expect(ops.listObjects()).toHaveLength(2);
  });

  test("createTree() 创建并写入 tree 对象", () => {
    const fileHash = ops.writeBlob(Buffer.from("content"));
    const treeHash = ops.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]);

    const tree = ops.catFile(treeHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("file.txt");
    }
  });

  test("createCommit() 创建 commit 对象", () => {
    const treeHash = ops.createTree([]);
    const commitHash = ops.createCommit(treeHash, [], "initial", testAuthor);

    const commit = ops.catFile(commitHash);
    expect(commit.type).toBe("commit");
    if (commit.type === "commit") {
      expect(commit.tree).toBe(treeHash);
      expect(commit.parents).toHaveLength(0);
      expect(commit.message).toBe("initial");
      expect(commit.author.name).toBe("Test User");
      expect(commit.committer).toEqual(commit.author);
    }
  });

  test("createCommit() 支持独立 committer", () => {
    const treeHash = ops.createTree([]);
    const committer: GitAuthor = {
      name: "Committer",
      email: "committer@example.com",
      timestamp: 1800000000,
      timezone: "+0000",
    };
    const commitHash = ops.createCommit(treeHash, [], "msg", testAuthor, committer);

    const commit = ops.catFile(commitHash);
    if (commit.type === "commit") {
      expect(commit.committer).not.toEqual(commit.author);
      expect(commit.committer.name).toBe("Committer");
    }
  });

  test("createCommit() 支持多父 commit", () => {
    const treeHash = ops.createTree([]);
    const p1 = ops.createCommit(treeHash, [], "parent1", testAuthor);
    const p2 = ops.createCommit(treeHash, [], "parent2", testAuthor);
    const mergeHash = ops.createCommit(treeHash, [p1, p2], "merge", testAuthor);

    const merge = ops.catFile(mergeHash);
    if (merge.type === "commit") {
      expect(merge.parents).toHaveLength(2);
      expect(merge.parents[0]).toBe(p1);
      expect(merge.parents[1]).toBe(p2);
    }
  });

  test("patchTree() 增量修改 tree", () => {
    const fileHash = ops.writeBlob(Buffer.from("content"));
    const treeHash = ops.createTree([]);

    const result = ops.patchTree(treeHash, [
      { op: "upsert", path: "new.txt", mode: "100644", hash: fileHash },
    ]);

    expect(result.rootHash).toBeDefined();
    expect(result.rootHash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.writtenTrees).toHaveLength(1);
  });
});
