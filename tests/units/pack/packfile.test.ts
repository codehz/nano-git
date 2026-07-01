/**
 * Packfile 读写测试
 */

import { describe, test, expect } from "bun:test";

import { InvalidPackError } from "@/errors.ts";
import { encodeObject, decodeObject } from "@/objects/raw.ts";
import { packObjectToRaw } from "@/pack/pack-reader-types.ts";
import { createPackReader } from "@/pack/pack-reader.ts";
import { createPackWriter } from "@/pack/pack-writer.ts";

import type { GitBlob, GitTree, GitCommit, GitAuthor } from "@/types/index.ts";

const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

describe("Packfile 读写", () => {
  test("写入和读取单个 blob", () => {
    const writer = createPackWriter();
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("hello world"),
    };
    const hash = writer.addRaw(encodeObject(blob));

    const packData = writer.build();
    const reader = createPackReader(packData);

    expect(reader.objectCount).toBe(1);
    expect(reader.has(hash)).toBe(true);

    const packObj = reader.getByHash(hash);
    expect(packObj).toBeDefined();
    const obj = packObjectToRaw(packObj!);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("hello world");
    }
  });

  test("写入和读取多个对象", () => {
    const writer = createPackWriter();

    const blob1: GitBlob = { type: "blob", content: Buffer.from("file1") };
    const blob2: GitBlob = { type: "blob", content: Buffer.from("file2") };
    const tree: GitTree = {
      type: "tree",
      entries: [
        { mode: "100644", name: "file1.txt", hash: writer.addRaw(encodeObject(blob1)) },
        { mode: "100644", name: "file2.txt", hash: writer.addRaw(encodeObject(blob2)) },
      ],
    };

    const hash1 = writer.addRaw(encodeObject(blob1));
    const hash2 = writer.addRaw(encodeObject(blob2));
    const treeHash = writer.addRaw(encodeObject(tree));

    const packData = writer.build();
    const reader = createPackReader(packData);

    expect(reader.objectCount).toBe(3);

    const obj1 = packObjectToRaw(reader.getByHash(hash1)!);
    expect(obj1.type).toBe("blob");

    const obj2 = packObjectToRaw(reader.getByHash(hash2)!);
    expect(obj2.type).toBe("blob");

    const objTree = packObjectToRaw(reader.getByHash(treeHash)!);
    expect(objTree.type).toBe("tree");
  });

  test("写入和读取 commit 对象", () => {
    const writer = createPackWriter();

    const tree: GitTree = { type: "tree", entries: [] };
    const treeHash = writer.addRaw(encodeObject(tree));

    const commit: GitCommit = {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: testAuthor,
      committer: testAuthor,
      message: "Initial commit",
    };
    const commitHash = writer.addRaw(encodeObject(commit));

    const packData = writer.build();
    const reader = createPackReader(packData);

    const packObj = reader.getByHash(commitHash);
    expect(packObj).toBeDefined();
    const obj = decodeObject(packObjectToRaw(packObj!));
    expect(obj.type).toBe("commit");
    if (obj.type === "commit") {
      expect(obj.message).toBe("Initial commit");
      expect(obj.tree).toBe(treeHash);
    }
  });

  test("重复对象只写入一次", () => {
    const writer = createPackWriter();
    const blob: GitBlob = { type: "blob", content: Buffer.from("deduplicated") };

    const hash1 = writer.addRaw(encodeObject(blob));
    const hash2 = writer.addRaw(encodeObject(blob));

    expect(hash2).toBe(hash1);
    expect(writer.objectCount).toBe(1);

    const reader = createPackReader(writer.build());
    expect(reader.objectCount).toBe(1);
    expect(reader.listHashes()).toEqual([hash1]);
  });

  test("损坏 pack 校验和时报错", () => {
    const writer = createPackWriter();
    writer.addRaw(encodeObject({ type: "blob", content: Buffer.from("checksum") }));

    const packData = writer.build();
    const corrupted = Buffer.from(packData);
    const lastIndex = corrupted.length - 1;
    corrupted[lastIndex] = corrupted[lastIndex]! ^ 0xff;

    expect(() => createPackReader(corrupted)).toThrow(InvalidPackError);
  });
});
