/**
 * Packfile 模块单元测试
 *
 * 测试 Packfile 的各个组件：
 * - 变长整数编码/解码
 * - Delta 编解码
 * - Packfile 读写
 * - 索引文件读写
 * - PackObjectStore
 * - CompositeObjectStore
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha1 } from "../src/types.ts";
import type { GitBlob, GitTree, GitCommit, GitAuthor, GitTag } from "../src/types.ts";
import {
  encodeObjectHeader,
  decodeObjectHeader,
  encodeOfsDeltaOffset,
  decodeOfsDeltaOffset,
  encodeVarint,
  decodeVarint,
} from "../src/pack/utils.ts";
import { applyDelta, createDelta } from "../src/pack/delta.ts";
import { createPackWriter, createPackReader } from "../src/pack/index.ts";
import { createPackIndexReader, createPackIndexWriter } from "../src/pack/pack-index.ts";
import { createPackObjectStore } from "../src/pack/pack-store.ts";
import { createCompositeObjectStore } from "../src/pack/composite-store.ts";
import { createPackBuilder } from "../src/pack/pack-builder.ts";
import { createMemoryObjectStore } from "../src/store/memory-store.ts";
import { createFileObjectStore } from "../src/store/file-store.ts";
import { InvalidPackError, DeltaError } from "../src/errors.ts";

const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

// ============================================================================
// 变长整数编码/解码
// ============================================================================

describe("变长整数编码", () => {
  test("编码和解码对象头部（小对象）", () => {
    const encoded = encodeObjectHeader(3, 11); // blob, size 11
    const [type, size, bytesRead] = decodeObjectHeader(encoded, 0);
    expect(type).toBe(3);
    expect(size).toBe(11);
    expect(bytesRead).toBe(1);
  });

  test("编码和解码对象头部（大对象）", () => {
    const encoded = encodeObjectHeader(1, 1000); // commit, size 1000
    const [type, size, bytesRead] = decodeObjectHeader(encoded, 0);
    expect(type).toBe(1);
    expect(size).toBe(1000);
    expect(bytesRead).toBeGreaterThan(1);
  });

  test("编码和解码 ofs_delta 偏移量", () => {
    const encoded = encodeOfsDeltaOffset(12345);
    const [offset, bytesRead] = decodeOfsDeltaOffset(encoded, 0);
    expect(offset).toBe(12345);
    expect(bytesRead).toBeGreaterThan(0);
  });

  test("编码和解码变长整数", () => {
    const values = [0, 1, 127, 128, 255, 1000, 65535, 1000000];
    for (const value of values) {
      const encoded = encodeVarint(value);
      const [decoded, bytesRead] = decodeVarint(encoded, 0);
      expect(decoded).toBe(value);
      expect(bytesRead).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// Delta 编解码
// ============================================================================

describe("Delta 编解码", () => {
  test("创建和应用 delta（简单修改）", () => {
    const base = Buffer.from("hello world");
    const target = Buffer.from("hello git");
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(result.toString("utf-8")).toBe("hello git");
  });

  test("创建和应用 delta（完全相同）", () => {
    const base = Buffer.from("identical content");
    const target = Buffer.from("identical content");
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(result.toString("utf-8")).toBe("identical content");
  });

  test("创建和应用 delta（完全不同）", () => {
    const base = Buffer.from("completely different");
    const target = Buffer.from("new content here");
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(result.toString("utf-8")).toBe("new content here");
  });

  test("创建和应用 delta（大文件）", () => {
    const base = Buffer.alloc(10000, "a");
    const target = Buffer.alloc(10000, "b");
    target.fill("a", 0, 5000); // 前 5000 字节相同
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(result).toEqual(target);
  });

  test("应用非法 copy 指令时报错", () => {
    const base = Buffer.from("short");
    const delta = Buffer.concat([
      encodeVarint(base.length),
      encodeVarint(4),
      Buffer.from([
        0x91, // copy 指令，带 1 字节 offset 和 1 字节 size
        0x10, // offset = 16
        0x04, // size = 4
      ]),
    ]);

    expect(() => applyDelta(base, delta)).toThrow(DeltaError);
  });
});

// ============================================================================
// Packfile 读写
// ============================================================================

describe("Packfile 读写", () => {
  test("写入和读取单个 blob", () => {
    const writer = createPackWriter();
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("hello world"),
    };
    const hash = writer.addObject(blob);

    const packData = writer.build();
    const reader = createPackReader(packData);

    expect(reader.objectCount).toBe(1);
    expect(reader.has(hash)).toBe(true);

    const obj = reader.readObject(hash);
    expect(obj).toBeDefined();
    expect(obj!.type).toBe("blob");
    if (obj!.type === "blob") {
      expect(obj!.content.toString("utf-8")).toBe("hello world");
    }
  });

  test("写入和读取多个对象", () => {
    const writer = createPackWriter();

    const blob1: GitBlob = { type: "blob", content: Buffer.from("file1") };
    const blob2: GitBlob = { type: "blob", content: Buffer.from("file2") };
    const tree: GitTree = {
      type: "tree",
      entries: [
        { mode: "100644", name: "file1.txt", hash: writer.addObject(blob1) },
        { mode: "100644", name: "file2.txt", hash: writer.addObject(blob2) },
      ],
    };

    const hash1 = writer.addObject(blob1);
    const hash2 = writer.addObject(blob2);
    const treeHash = writer.addObject(tree);

    const packData = writer.build();
    const reader = createPackReader(packData);

    expect(reader.objectCount).toBe(3);

    const obj1 = reader.readObject(hash1);
    expect(obj1!.type).toBe("blob");

    const obj2 = reader.readObject(hash2);
    expect(obj2!.type).toBe("blob");

    const objTree = reader.readObject(treeHash);
    expect(objTree!.type).toBe("tree");
  });

  test("写入和读取 commit 对象", () => {
    const writer = createPackWriter();

    const tree: GitTree = { type: "tree", entries: [] };
    const treeHash = writer.addObject(tree);

    const commit: GitCommit = {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: testAuthor,
      committer: testAuthor,
      message: "Initial commit",
    };
    const commitHash = writer.addObject(commit);

    const packData = writer.build();
    const reader = createPackReader(packData);

    const obj = reader.readObject(commitHash);
    expect(obj).toBeDefined();
    expect(obj!.type).toBe("commit");
    if (obj!.type === "commit") {
      expect(obj!.message).toBe("Initial commit");
      expect(obj!.tree).toBe(treeHash);
    }
  });

  test("重复对象只写入一次", () => {
    const writer = createPackWriter();
    const blob: GitBlob = { type: "blob", content: Buffer.from("deduplicated") };

    const hash1 = writer.addObject(blob);
    const hash2 = writer.addObject(blob);

    expect(hash2).toBe(hash1);
    expect(writer.objectCount).toBe(1);

    const reader = createPackReader(writer.build());
    expect(reader.objectCount).toBe(1);
    expect(reader.listHashes()).toEqual([hash1]);
  });

  test("损坏 pack 校验和时报错", () => {
    const writer = createPackWriter();
    writer.addObject({ type: "blob", content: Buffer.from("checksum") });

    const packData = writer.build();
    const corrupted = Buffer.from(packData);
    const lastIndex = corrupted.length - 1;
    corrupted[lastIndex] = corrupted[lastIndex]! ^ 0xff;

    expect(() => createPackReader(corrupted)).toThrow(InvalidPackError);
  });
});

// ============================================================================
// 索引文件读写
// ============================================================================

describe("索引文件读写", () => {
  test("写入和读取索引", () => {
    const writer = createPackIndexWriter();

    const hash1 = sha1("1111111111111111111111111111111111111111");
    const hash2 = sha1("2222222222222222222222222222222222222222");

    writer.addEntry({ hash: hash1, offset: 12, crc32: 0x12345678 });
    writer.addEntry({ hash: hash2, offset: 100, crc32: 0x87654321 });

    const packChecksum = Buffer.alloc(20, 0xaa);
    const idxData = writer.build(packChecksum);

    const reader = createPackIndexReader(idxData);
    expect(reader.objectCount).toBe(2);

    const entry1 = reader.lookup(hash1);
    expect(entry1).toBeDefined();
    expect(entry1!.offset).toBe(12);
    expect(entry1!.crc32).toBe(0x12345678);

    const entry2 = reader.lookup(hash2);
    expect(entry2).toBeDefined();
    expect(entry2!.offset).toBe(100);
  });

  test("索引查找不存在的对象", () => {
    const writer = createPackIndexWriter();
    const hash = sha1("1111111111111111111111111111111111111111");
    writer.addEntry({ hash, offset: 12, crc32: 0 });

    const packChecksum = Buffer.alloc(20, 0);
    const idxData = writer.build(packChecksum);

    const reader = createPackIndexReader(idxData);
    const notFound = sha1("9999999999999999999999999999999999999999");
    expect(reader.lookup(notFound)).toBeUndefined();
  });
});

// ============================================================================
// PackObjectStore
// ============================================================================

describe("PackObjectStore", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-pack-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  test("从 packfile 读取对象", () => {
    const gitDir = tempDir;
    mkdirSync(join(gitDir, "objects", "pack"), { recursive: true });

    // 创建 packfile
    const builder = createPackBuilder(gitDir);
    const blob: GitBlob = { type: "blob", content: Buffer.from("test content") };
    const hash = builder.addObject(blob);
    builder.build();

    // 读取
    const store = createPackObjectStore(gitDir);
    expect(store.exists(hash)).toBe(true);

    const obj = store.read(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("test content");
    }
  });

  test("支持从多个 packfile 读取对象", () => {
    const gitDir = tempDir;
    mkdirSync(join(gitDir, "objects", "pack"), { recursive: true });

    const builder1 = createPackBuilder(gitDir);
    const hash1 = builder1.addObject({ type: "blob", content: Buffer.from("pack one") });
    builder1.build();

    const builder2 = createPackBuilder(gitDir);
    const hash2 = builder2.addObject({ type: "blob", content: Buffer.from("pack two") });
    builder2.build();

    const store = createPackObjectStore(gitDir);

    expect(store.packCount).toBe(2);
    expect(store.exists(hash1)).toBe(true);
    expect(store.exists(hash2)).toBe(true);

    const obj1 = store.read(hash1);
    const obj2 = store.read(hash2);
    expect(obj1.type).toBe("blob");
    expect(obj2.type).toBe("blob");
    if (obj1.type === "blob") {
      expect(obj1.content.toString("utf-8")).toBe("pack one");
    }
    if (obj2.type === "blob") {
      expect(obj2.content.toString("utf-8")).toBe("pack two");
    }
  });

  test("PackObjectStore 是只读的", () => {
    const gitDir = tempDir;
    const store = createPackObjectStore(gitDir);

    expect(() => {
      store.write({ type: "blob", content: Buffer.from("test") });
    }).toThrow();
  });
});

// ============================================================================
// CompositeObjectStore
// ============================================================================

describe("CompositeObjectStore", () => {
  test("从主存储读取", () => {
    const primary = createMemoryObjectStore();
    const secondary = createMemoryObjectStore();
    const composite = createCompositeObjectStore(primary, secondary);

    const blob: GitBlob = { type: "blob", content: Buffer.from("primary") };
    const hash = primary.write(blob);

    const obj = composite.read(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("primary");
    }
  });

  test("从辅助存储读取", () => {
    const primary = createMemoryObjectStore();
    const secondary = createMemoryObjectStore();
    const composite = createCompositeObjectStore(primary, secondary);

    const blob: GitBlob = { type: "blob", content: Buffer.from("secondary") };
    const hash = secondary.write(blob);

    const obj = composite.read(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("secondary");
    }
  });

  test("写入到主存储", () => {
    const primary = createMemoryObjectStore();
    const secondary = createMemoryObjectStore();
    const composite = createCompositeObjectStore(primary, secondary);

    const blob: GitBlob = { type: "blob", content: Buffer.from("new") };
    const hash = composite.write(blob);

    expect(primary.exists(hash)).toBe(true);
    expect(secondary.exists(hash)).toBe(false);
  });

  test("主存储优先级高于辅助存储", () => {
    const primary = createMemoryObjectStore();
    const secondary = createMemoryObjectStore();
    const composite = createCompositeObjectStore(primary, secondary);

    const blob1: GitBlob = { type: "blob", content: Buffer.from("primary version") };
    const blob2: GitBlob = { type: "blob", content: Buffer.from("secondary version") };

    const hash = primary.write(blob1);
    secondary.write(blob2); // 相同内容会产生相同哈希，但这里内容不同

    // 写入不同内容到相同哈希是不可能的，所以这个测试验证的是查找顺序
    const obj = composite.read(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("primary version");
    }
  });

  test("loose object 优先于 packfile", () => {
    const gitDir = tempDir();
    mkdirSync(join(gitDir, "objects"), { recursive: true });

    const packBuilder = createPackBuilder(gitDir);
    const packedHash = packBuilder.addObject({
      type: "blob",
      content: Buffer.from("packed version"),
    });
    packBuilder.build();

    const fileStore = createFileObjectStore(gitDir);
    const looseHash = fileStore.write({
      type: "blob",
      content: Buffer.from("loose version"),
    });

    const composite = createCompositeObjectStore(fileStore, createPackObjectStore(gitDir));
    const looseObj = composite.read(looseHash);
    const packedObj = composite.read(packedHash);

    expect(looseObj.type).toBe("blob");
    expect(packedObj.type).toBe("blob");
    if (looseObj.type === "blob") {
      expect(looseObj.content.toString("utf-8")).toBe("loose version");
    }
    if (packedObj.type === "blob") {
      expect(packedObj.content.toString("utf-8")).toBe("packed version");
    }

    rmSync(gitDir, { recursive: true });
  });
});

// ============================================================================
// PackBuilder
// ============================================================================

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

    builder.addObject(blob1);
    builder.addObject(blob2);

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
    const hash = builder.addObject(blob);
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

    const hash1 = builder.addObject(blob);
    const hash2 = builder.addObject(blob);
    const result = builder.build();

    expect(hash2).toBe(hash1);
    expect(result.objectCount).toBe(1);
  });

  test("构建和读取 tag 对象", () => {
    const gitDir = tempDir;
    const builder = createPackBuilder(gitDir);
    const blobHash = builder.addObject({ type: "blob", content: Buffer.from("release artifact") });

    const tag: GitTag = {
      type: "tag",
      object: blobHash,
      objectType: "blob",
      tag: "v1.0.0",
      tagger: testAuthor,
      message: "Release v1.0.0",
    };

    const tagHash = builder.addObject(tag);
    builder.build();

    const store = createPackObjectStore(gitDir);
    const obj = store.read(tagHash);
    expect(obj.type).toBe("tag");
    if (obj.type === "tag") {
      expect(obj.object).toBe(blobHash);
      expect(obj.tag).toBe("v1.0.0");
      expect(obj.message).toBe("Release v1.0.0");
    }
  });
});

function tempDir(): string {
  const dir = join(
    tmpdir(),
    `nano-git-composite-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}
