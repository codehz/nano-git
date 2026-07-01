/**
 * ODB 合同测试：基础读写语义
 */
import { describe, expect, test } from "bun:test";

import { objectDatabaseBackends } from "./contract.ts";
import { readObject, writeObject } from "@/objects/raw.ts";
import { sha1 } from "@/types/index.ts";

import type { GitAuthor, GitBlob, GitCommit, GitTree } from "@/types/index.ts";

const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

describe("ObjectDatabase contract: basic", () => {
  describe.each(objectDatabaseBackends)("$name", ({ createStore }) => {
    test("写入并读取 blob 对象", () => {
      using session = createStore();
      const { store } = session;

      const blob: GitBlob = {
        type: "blob",
        content: Buffer.from("hello world"),
      };
      const hash = writeObject(store, blob);

      expect(hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));

      const read = store.read(hash);
      expect(read.type).toBe("blob");
      expect(read.hash).toBe(hash);
      if (read.type === "blob") {
        expect(read.content.toString("utf-8")).toBe("hello world");
      }
    });

    test("写入并读取 tree 对象", () => {
      using session = createStore();
      const { store } = session;

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
      using session = createStore();
      const { store } = session;

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

    test("相同内容重复写入保持幂等", () => {
      using session = createStore();
      const { store } = session;

      const blob: GitBlob = {
        type: "blob",
        content: Buffer.from("duplicate"),
      };
      const hash1 = writeObject(store, blob);
      const hash2 = writeObject(store, blob);

      expect(hash1).toBe(hash2);
      expect(store.list()).toEqual([hash1]);
    });

    test("exists / tryRead / read 在命中与未命中时行为正确", () => {
      using session = createStore();
      const { store } = session;

      const hash = writeObject(store, {
        type: "blob",
        content: Buffer.from("test"),
      });
      const missingHash = sha1("0000000000000000000000000000000000000000");

      expect(store.exists(hash)).toBe(true);
      expect(store.exists(missingHash)).toBe(false);
      expect(store.tryRead(hash)?.hash).toBe(hash);
      expect(store.tryRead(missingHash)).toBeUndefined();
      expect(() => store.read(missingHash)).toThrow("Object not found");
    });

    test("list 返回当前对象集合", () => {
      using session = createStore();
      const { store } = session;

      expect(store.list()).toHaveLength(0);

      const hash1 = writeObject(store, { type: "blob", content: Buffer.from("a") });
      const hash2 = writeObject(store, { type: "blob", content: Buffer.from("b") });

      const list = store.list();
      expect(list).toHaveLength(2);
      expect(list).toContain(hash1);
      expect(list).toContain(hash2);
    });

    test("delete 删除已有对象，删除不存在对象保持静默", () => {
      using session = createStore();
      const { store } = session;

      const hash = writeObject(store, {
        type: "blob",
        content: Buffer.from("to-delete"),
      });
      const missingHash = sha1("0000000000000000000000000000000000000000");

      store.delete(hash);
      expect(store.exists(hash)).toBe(false);
      expect(store.tryRead(hash)).toBeUndefined();
      expect(() => store.delete(missingHash)).not.toThrow();
    });
  });
});
