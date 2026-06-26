/**
 * ODB 合同测试：RawGitObject 摄入与跨后端一致性
 */
import { describe, expect, test } from "bun:test";

import { objectDatabaseBackends } from "./contract.ts";
import { sha1 } from "@/core/types.ts";
import { encodeObject, readObject, writeObject } from "@/objects/raw.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";

import type { GitBlob, GitTree, RawGitObject } from "@/core/types.ts";

describe("ObjectDatabase contract: raw", () => {
  describe.each(objectDatabaseBackends)("$name", ({ createStore }) => {
    test("ingest 可直接写入 RawGitObject", () => {
      using session = createStore();
      const { store } = session;

      const raw: RawGitObject = {
        hash: sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"),
        type: "blob",
        content: Buffer.from("hello world"),
      };

      store.ingest(raw);

      expect(store.read(raw.hash)).toEqual(raw);
    });

    test("ingest 遇到 hash 不匹配时抛错", () => {
      using session = createStore();
      const { store } = session;

      const invalidRaw: RawGitObject = {
        hash: sha1("0000000000000000000000000000000000000000"),
        type: "blob",
        content: Buffer.from("mismatched content"),
      };

      expect(() => store.ingest(invalidRaw)).toThrow("hash mismatch");
      expect(store.list()).toEqual([]);
    });

    test("跨后端导入后 hash 与原始字节保持一致", () => {
      using session = createStore();
      const { store } = session;
      const memoryStore = createMemoryObjectStore();

      const blob: GitBlob = {
        type: "blob",
        content: Buffer.from("迁移测试内容"),
      };
      const blobHash = writeObject(memoryStore, blob);
      const tree: GitTree = {
        type: "tree",
        entries: [{ mode: "100644", name: "migrated.txt", hash: blobHash }],
      };
      const treeHash = writeObject(memoryStore, tree);

      store.ingest(memoryStore.read(blobHash));
      store.ingest(memoryStore.read(treeHash));

      expect(store.exists(blobHash)).toBe(true);
      expect(store.exists(treeHash)).toBe(true);
      expect(store.read(blobHash)).toEqual(memoryStore.read(blobHash));
      expect(store.read(treeHash)).toEqual(memoryStore.read(treeHash));

      const readTree = readObject(store, treeHash);
      expect(readTree.type).toBe("tree");
      if (readTree.type === "tree") {
        expect(readTree.entries).toEqual(tree.entries);
      }
    });

    test("ingestMany 批量写入多个对象", () => {
      using session = createStore();
      const { store } = session;

      const raws = [
        encodeObject({ type: "blob", content: Buffer.from("hello world") }),
        encodeObject({ type: "blob", content: Buffer.from("hello") }),
      ];

      store.ingestMany(raws);

      expect(store.list()).toHaveLength(2);
      for (const raw of raws) {
        expect(store.exists(raw.hash)).toBe(true);
        expect(store.read(raw.hash)).toEqual(raw);
      }
    });

    test("ingestMany 遇到非法对象时抛错", () => {
      using session = createStore();
      const { store } = session;

      const validRaw = encodeObject({ type: "blob", content: Buffer.from("hello world") });
      const invalidRaw: RawGitObject = {
        hash: sha1("0000000000000000000000000000000000000000"),
        type: "blob",
        content: Buffer.from("mismatched content"),
      };

      expect(() => store.ingestMany([validRaw, invalidRaw])).toThrow("hash mismatch");
    });
  });
});
