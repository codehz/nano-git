/**
 * SQLite 对象存储单元测试
 */

import { Database } from "bun:sqlite";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import { ObjectNotFoundError } from "@/core/errors.ts";
import { sha1 } from "@/core/types.ts";
import { writeObject, readObject, encodeObject } from "@/objects/raw.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";
import { createSqliteObjectStore } from "@/odb/sqlite.ts";

import type { GitBlob, GitTree, GitCommit, GitAuthor } from "@/core/types.ts";
import type { RawGitObject } from "@/core/types.ts";

const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

describe("createSqliteObjectStore()", () => {
  let db: Database;
  let store: ReturnType<typeof createSqliteObjectStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(
      "CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, type TEXT NOT NULL, content BLOB NOT NULL)",
    );
    store = createSqliteObjectStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("写入并读取 blob 对象", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("hello world"),
    };
    const hash = writeObject(store, blob);
    expect(hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));

    const read = store.read(hash);
    expect(read.type).toBe("blob");
    if (read.type === "blob") {
      expect(read.content.toString("utf-8")).toBe("hello world");
    }
  });

  test("写入并读取 tree 对象", () => {
    const blobHash = writeObject(store, {
      type: "blob",
      content: Buffer.from("content"),
    });

    const tree: GitTree = {
      type: "tree",
      entries: [{ mode: "100644", name: "file.txt", hash: blobHash }],
    };
    const treeHash = writeObject(store, tree);

    const read = readObject(store, treeHash);
    expect(read.type).toBe("tree");
    if (read.type === "tree") {
      expect(read.entries).toHaveLength(1);
      expect(read.entries[0]!.name).toBe("file.txt");
      expect(read.entries[0]!.hash).toBe(blobHash);
    }
  });

  test("写入并读取 commit 对象", () => {
    const treeHash = writeObject(store, { type: "tree", entries: [] });
    const commit: GitCommit = {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: testAuthor,
      committer: testAuthor,
      message: "Initial commit",
    };
    const commitHash = writeObject(store, commit);

    const read = readObject(store, commitHash);
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
    const hash1 = writeObject(store, blob);
    const hash2 = writeObject(store, blob);
    expect(hash1).toBe(hash2);
    expect(store.list()).toHaveLength(1);
  });

  test("exists() 正确判断对象是否存在", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("test"),
    };
    const hash = writeObject(store, blob);
    expect(store.exists(hash)).toBe(true);
    expect(store.exists(sha1("0000000000000000000000000000000000000000"))).toBe(false);
  });

  test("读取不存在的对象应抛出 ObjectNotFoundError", () => {
    const fakeHash = sha1("0000000000000000000000000000000000000000");
    expect(() => store.read(fakeHash)).toThrow(ObjectNotFoundError);
    expect(() => store.read(fakeHash)).toThrow("Object not found");
  });

  test("tryRead 在不存在的对象时返回 undefined", () => {
    const fakeHash = sha1("0000000000000000000000000000000000000000");
    expect(store.tryRead(fakeHash)).toBeUndefined();
  });

  test("list() 返回所有存储的哈希，按哈希排序", () => {
    expect(store.list()).toHaveLength(0);

    const hash1 = writeObject(store, { type: "blob", content: Buffer.from("a") });
    const hash2 = writeObject(store, { type: "blob", content: Buffer.from("b") });

    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list).toContain(hash1);
    expect(list).toContain(hash2);
  });

  test("delete() 移除对象后 list 不再包含该哈希", () => {
    const hash = writeObject(store, { type: "blob", content: Buffer.from("to-delete") });
    expect(store.list()).toHaveLength(1);

    store.delete(hash);
    expect(store.list()).toHaveLength(0);
    expect(store.exists(hash)).toBe(false);
  });

  test("delete() 删除不存在的对象静默成功", () => {
    const fakeHash = sha1("0000000000000000000000000000000000000000");
    expect(() => store.delete(fakeHash)).not.toThrow();
  });

  test("ingestMany 批量写入多个对象", () => {
    const raw1: RawGitObject = {
      hash: sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"),
      type: "blob",
      content: Buffer.from("hello world"),
    };
    const raw2: RawGitObject = {
      hash: sha1("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0"),
      type: "blob",
      content: Buffer.from("hello"),
    };

    store.ingestMany([raw1, raw2]);
    expect(store.list()).toHaveLength(2);
    expect(store.exists(raw1.hash)).toBe(true);
    expect(store.exists(raw2.hash)).toBe(true);
  });

  test("ingestMany 原子性：中途出错时全部回滚", () => {
    const validRaw: RawGitObject = {
      hash: sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"),
      type: "blob",
      content: Buffer.from("hello world"),
    };
    // hash 与内容不匹配的对象，应触发校验失败
    const invalidRaw: RawGitObject = {
      hash: sha1("0000000000000000000000000000000000000000"),
      type: "blob",
      content: Buffer.from("mismatched content"),
    };

    expect(() => store.ingestMany([validRaw, invalidRaw])).toThrow("hash mismatch");
    // 原子性：第一个对象也不应该被写入
    expect(store.list()).toHaveLength(0);
  });

  test("直接通过 RawGitObject 的 ingest 和 read", () => {
    const raw: RawGitObject = {
      hash: sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"),
      type: "blob",
      content: Buffer.from("hello world"),
    };

    store.ingest(raw);
    const result = store.read(raw.hash);
    expect(result.hash).toBe(raw.hash);
    expect(result.type).toBe("blob");
    expect(result.content.toString()).toBe("hello world");
  });

  test("大数据量：ingest 1000 个对象 + list 完整性", () => {
    const raws: RawGitObject[] = [];
    for (let i = 0; i < 1000; i++) {
      raws.push(encodeObject({ type: "blob", content: Buffer.from(`large-data-${i}`) }));
    }

    store.ingestMany(raws);

    const list = store.list();
    expect(list).toHaveLength(1000);

    // 验证所有对象可按 hash 读取
    for (const raw of raws) {
      expect(store.exists(raw.hash)).toBe(true);
      const read = store.read(raw.hash);
      expect(read.type).toBe("blob");
      // 验证内容是期望的
      expect(read.content).toEqual(raw.content);
    }
  });

  test("跨后端哈希一致性：用 memory 后端序列化，SQLite 后端读取", () => {
    const memStore = createMemoryObjectStore();

    // 使用 memory 后端创建对象，验证跨后端迁移时 hash 保持稳定
    const blob: GitBlob = { type: "blob", content: Buffer.from("迁移测试内容") };
    const blobHash = writeObject(memStore, blob);

    const tree: GitTree = {
      type: "tree",
      entries: [{ mode: "100644", name: "migrated.txt", hash: blobHash }],
    };
    const treeHash = writeObject(memStore, tree);

    // 将 memory 后端产出的 RawGitObject 导入 SQLite 后端
    store.ingest(memStore.read(blobHash));
    store.ingest(memStore.read(treeHash));

    // 验证同一语义对象在不同后端下保持相同 hash
    expect(store.exists(blobHash)).toBe(true);
    expect(store.exists(treeHash)).toBe(true);
    expect(store.read(blobHash).hash).toBe(blobHash);
    expect(store.read(treeHash).hash).toBe(treeHash);

    // 验证跨后端导入前后的原始字节完全一致
    expect(store.read(blobHash)).toEqual(memStore.read(blobHash));
    expect(store.read(treeHash)).toEqual(memStore.read(treeHash));

    const readBlob = store.read(blobHash);
    expect(readBlob.type).toBe("blob");
    if (readBlob.type === "blob") {
      expect(readBlob.content.toString("utf-8")).toBe("迁移测试内容");
    }

    const readTree = readObject(store, treeHash);
    expect(readTree.type).toBe("tree");
    if (readTree.type === "tree") {
      expect(readTree.entries).toEqual(tree.entries);
    }
  });
});
