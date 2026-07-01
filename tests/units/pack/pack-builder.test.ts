/**
 * PackBuilder 单元测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeObject, readObject } from "@/objects/raw.ts";
import { createPackBuilder } from "@/pack/builder/pack-builder.ts";
import { createPackObjectStore } from "@/pack/store/pack-store.ts";

import type { GitBlob, GitTag, GitAuthor } from "@/types/index.ts";

const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

describe("PackBuilder", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-builder-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  test("构建 packfile 和索引", () => {
    const gitDir = tempDir;
    const builder = createPackBuilder(gitDir);

    const blob1: GitBlob = { type: "blob", content: Buffer.from("file1") };
    const blob2: GitBlob = { type: "blob", content: Buffer.from("file2") };

    builder.addRaw(encodeObject(blob1));
    builder.addRaw(encodeObject(blob2));

    const result = builder.build();

    expect(result.objectCount).toBe(2);
    expect(existsSync(result.packPath)).toBe(true);
    expect(existsSync(result.idxPath)).toBe(true);
    expect(result.checksum).toMatch(/^[0-9a-f]{40}$/);
  });

  test("构建的 packfile 可以被读取", () => {
    const gitDir = tempDir;
    const builder = createPackBuilder(gitDir);

    const blob: GitBlob = { type: "blob", content: Buffer.from("test") };
    const hash = builder.addRaw(encodeObject(blob));
    builder.build();

    const store = createPackObjectStore(gitDir);
    const obj = store.read(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("test");
    }
  });

  test("构建器会去重重复对象", () => {
    const gitDir = tempDir;
    const builder = createPackBuilder(gitDir);
    const blob: GitBlob = { type: "blob", content: Buffer.from("same content") };

    const hash1 = builder.addRaw(encodeObject(blob));
    const hash2 = builder.addRaw(encodeObject(blob));
    const result = builder.build();

    expect(hash2).toBe(hash1);
    expect(result.objectCount).toBe(1);
  });

  test("构建和读取 tag 对象", () => {
    const gitDir = tempDir;
    const builder = createPackBuilder(gitDir);
    const blobHash = builder.addRaw(
      encodeObject({ type: "blob", content: Buffer.from("release artifact") }),
    );

    const tag: GitTag = {
      type: "tag",
      object: blobHash,
      objectType: "blob",
      tag: "v1.0.0",
      tagger: testAuthor,
      message: "Release v1.0.0",
    };

    const tagHash = builder.addRaw(encodeObject(tag));
    builder.build();

    const store = createPackObjectStore(gitDir);
    const obj = readObject(store, tagHash);
    expect(obj.type).toBe("tag");
    if (obj.type === "tag") {
      expect(obj.object).toBe(blobHash);
      expect(obj.tag).toBe("v1.0.0");
      expect(obj.message).toBe("Release v1.0.0");
    }
  });
});
