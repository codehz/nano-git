/**
 * Packfile 读写测试
 */

import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import {
  allocBytes,
  bytes,
  bytesToUtf8,
  concatBytes,
  copyBytes,
  hexToBytes,
  toUint8Array,
  writeU32BE,
} from "../../helpers/bytes.ts";
import { InvalidPackError, ObjectNotFoundError } from "@/errors.ts";
import { hashObject } from "@/hash/index.ts";
import { encodeObject, decodeObject } from "@/objects/raw.ts";
import { PACK_HEADER_SIZE, PACK_SIGNATURE, PACK_VERSION } from "@/pack/constants.ts";
import { createDelta } from "@/pack/delta/delta.ts";
import { createPackIndexReader } from "@/pack/idx/pack-index.ts";
import { createPackIndexWriter } from "@/pack/idx/pack-index.ts";
import { packObjectToRaw } from "@/pack/reader/pack-reader-types.ts";
import { createPackReader } from "@/pack/reader/pack-reader.ts";
import { encodeObjectHeader, encodeOfsDeltaOffset } from "@/pack/utils/utils.ts";
import { buildEncodedPack, toEncodedPackObject } from "@/pack/writer/pack-encoding.ts";
import { createPackWriter } from "@/pack/writer/pack-writer.ts";
import { sha1 } from "@/types/index.ts";

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
      content: bytes("hello world"),
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
      expect(bytesToUtf8(obj.content)).toBe("hello world");
    }
  });

  test("写入和读取多个对象", () => {
    const writer = createPackWriter();

    const blob1: GitBlob = { type: "blob", content: bytes("file1") };
    const blob2: GitBlob = { type: "blob", content: bytes("file2") };
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
    const blob: GitBlob = { type: "blob", content: bytes("deduplicated") };

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
    writer.addRaw(encodeObject({ type: "blob", content: bytes("checksum") }));

    const packData = writer.build();
    const corrupted = toUint8Array(packData);
    const lastIndex = corrupted.length - 1;
    corrupted[lastIndex] = corrupted[lastIndex]! ^ 0xff;

    expect(() => createPackReader(corrupted)).toThrow(InvalidPackError);
  });

  test("getByOffset 返回正确的对象", () => {
    const writer = createPackWriter();
    const blob: GitBlob = { type: "blob", content: bytes("offset test") };
    const hash = writer.addRaw(encodeObject(blob));
    const packData = writer.build();

    const reader = createPackReader(packData);
    // 第一个对象的 offset 是 PACK_HEADER_SIZE (12)
    const obj = reader.getByOffset(PACK_HEADER_SIZE);
    expect(obj).toBeDefined();
    expect(obj!.hash).toBe(hash);
  });

  test("getByOffset 返回 undefined 对于不存在的偏移", () => {
    const writer = createPackWriter();
    writer.addRaw(encodeObject({ type: "blob", content: bytes("test") }));
    const packData = writer.build();

    const reader = createPackReader(packData);
    expect(reader.getByOffset(9999)).toBeUndefined();
  });

  test("objects() 迭代所有对象", () => {
    const writer = createPackWriter();
    writer.addRaw(encodeObject({ type: "blob", content: bytes("obj1") }));
    writer.addRaw(encodeObject({ type: "blob", content: bytes("obj2") }));
    writer.addRaw(encodeObject({ type: "blob", content: bytes("obj3") }));
    const packData = writer.build();

    const reader = createPackReader(packData);
    const objects = Array.from(reader.objects());
    expect(objects).toHaveLength(3);
    expect(objects.map((o) => o.type)).toEqual(["blob", "blob", "blob"]);
  });

  test("空 packfile（0 个对象）可正常解析", () => {
    const packData = buildEncodedPack([]).packData;
    const reader = createPackReader(packData);
    expect(reader.objectCount).toBe(0);
    expect(Array.from(reader.objects())).toHaveLength(0);
    expect(reader.listHashes()).toHaveLength(0);
  });

  test("读取 ofs_delta 对象", () => {
    // 构造一个包含 base blob + ofs_delta 的 packfile
    const baseContent = bytes("hello world");
    const targetContent = bytes("hello git");
    const deltaData = createDelta(baseContent, targetContent);

    // 编码 base 对象
    const baseRaw = {
      type: "blob" as const,
      hash: hashObject("blob", baseContent),
      content: baseContent,
    };
    const baseObjHeader = encodeObjectHeader(3, baseContent.length);
    const baseCompressed = deflateSync(baseContent);
    const baseObjectLength = baseObjHeader.length + baseCompressed.length;

    // 构建整个 packfile
    const objectCount = 2;
    const header = allocBytes(12);
    copyBytes(header, 0, PACK_SIGNATURE);
    writeU32BE(header, 4, PACK_VERSION);
    writeU32BE(header, 8, objectCount);

    // 第一个对象：base blob 位于 offset 12
    const baseOffset = 12;
    // 第二个对象（delta）的起始偏移 = baseOffset + baseObjectLength
    const deltaObjStart = baseOffset + baseObjectLength;

    const deltaHeader = encodeObjectHeader(6, deltaData.length); // type=6 (ofs_delta)
    const negOffset = deltaObjStart - baseOffset; // = baseObjectLength
    const encodedNegOffset = encodeOfsDeltaOffset(negOffset);
    const deltaCompressed = deflateSync(deltaData);

    const body = concatBytes(
      baseObjHeader,
      baseCompressed,
      deltaHeader,
      encodedNegOffset,
      deltaCompressed,
    );

    const bodyWithHeader = concatBytes(header, body);
    const checksum = createHash("sha1").update(bodyWithHeader).digest();
    const packData = concatBytes(bodyWithHeader, checksum);

    const reader = createPackReader(packData);
    expect(reader.objectCount).toBe(2);

    // 验证 base 对象
    const baseObj = reader.getByHash(baseRaw.hash);
    expect(baseObj).toBeDefined();
    expect(baseObj!.type).toBe("blob");
    expect(bytesToUtf8(baseObj!.data)).toBe("hello world");

    // 验证 delta 解析后的 target 对象
    const targetHash = hashObject("blob", targetContent);
    const targetObj = reader.getByHash(targetHash);
    expect(targetObj).toBeDefined();
    expect(targetObj!.type).toBe("blob");
    expect(bytesToUtf8(targetObj!.data)).toBe("hello git");
  });

  test("读取 ref_delta 对象", () => {
    const baseContent = bytes("hello world");
    const targetContent = bytes("hello git");
    const deltaData = createDelta(baseContent, targetContent);

    // 编码 base 对象
    const baseRaw = {
      type: "blob" as const,
      hash: hashObject("blob", baseContent),
      content: baseContent,
    };
    const baseObjHeader = encodeObjectHeader(3, baseContent.length);
    const baseCompressed = deflateSync(baseContent);

    // 构建整个 packfile
    const objectCount = 2;
    const header = allocBytes(12);
    copyBytes(header, 0, PACK_SIGNATURE);
    writeU32BE(header, 4, PACK_VERSION);
    writeU32BE(header, 8, objectCount);

    // 第二个对象 header: type=7 (ref_delta)
    const deltaHeader = encodeObjectHeader(7, deltaData.length);
    // 20 字节 base hash (binary)
    const baseHashBin = hexToBytes(baseRaw.hash);
    const deltaCompressed = deflateSync(deltaData);

    const body = concatBytes(
      baseObjHeader,
      baseCompressed,
      deltaHeader,
      baseHashBin,
      deltaCompressed,
    );

    const bodyWithHeader = concatBytes(header, body);
    const checksum = createHash("sha1").update(bodyWithHeader).digest();
    const packData = concatBytes(bodyWithHeader, checksum);

    const reader = createPackReader(packData);
    expect(reader.objectCount).toBe(2);

    // 验证 base 对象
    const baseObj = reader.getByHash(baseRaw.hash);
    expect(baseObj).toBeDefined();
    expect(baseObj!.type).toBe("blob");

    // 验证 delta 解析后的 target 对象
    const targetHash = hashObject("blob", targetContent);
    const targetObj = reader.getByHash(targetHash);
    expect(targetObj).toBeDefined();
    expect(targetObj!.type).toBe("blob");
    expect(bytesToUtf8(targetObj!.data)).toBe("hello git");
  });

  test("ofs_delta base 不存在时抛出 InvalidPackError", () => {
    // 只有 ofs_delta 对象，没有 base 对象
    const deltaData = Uint8Array.from([0x00]); // 最小 delta
    const objectCount = 1;
    const header = allocBytes(12);
    copyBytes(header, 0, PACK_SIGNATURE);
    writeU32BE(header, 4, PACK_VERSION);
    writeU32BE(header, 8, objectCount);

    const deltaHeader = encodeObjectHeader(6, deltaData.length);
    const encodedNegOffset = encodeOfsDeltaOffset(100); // 指向不存在的偏移
    const deltaCompressed = deflateSync(deltaData);

    const body = concatBytes(deltaHeader, encodedNegOffset, deltaCompressed);
    const bodyWithHeader = concatBytes(header, body);
    const checksum = createHash("sha1").update(bodyWithHeader).digest();
    const packData = concatBytes(bodyWithHeader, checksum);

    const reader = createPackReader(packData);
    expect(() => reader.getByHash(sha1("0000000000000000000000000000000000000000"))).toThrow(
      InvalidPackError,
    );
  });

  test("ref_delta base 不存在时抛出 ObjectNotFoundError", () => {
    const deltaData = Uint8Array.from([0x00]);
    const objectCount = 1;
    const header = allocBytes(12);
    copyBytes(header, 0, PACK_SIGNATURE);
    writeU32BE(header, 4, PACK_VERSION);
    writeU32BE(header, 8, objectCount);

    const deltaHeader = encodeObjectHeader(7, deltaData.length);
    const baseHashBin = allocBytes(20, 0xff); // 不存在的哈希
    const deltaCompressed = deflateSync(deltaData);

    const body = concatBytes(deltaHeader, baseHashBin, deltaCompressed);
    const bodyWithHeader = concatBytes(header, body);
    const checksum = createHash("sha1").update(bodyWithHeader).digest();
    const packData = concatBytes(bodyWithHeader, checksum);

    const reader = createPackReader(packData);
    expect(() => reader.getByHash(sha1("0000000000000000000000000000000000000000"))).toThrow(
      ObjectNotFoundError,
    );
  });

  test("编写 pack 后可通过 idx 索引", () => {
    const blob: GitBlob = { type: "blob", content: bytes("hello") };
    const entries = buildEncodedPack([toEncodedPackObject(encodeObject(blob))]).entries;

    const idx = createPackIndexWriter();
    for (const entry of entries) {
      idx.addEntry(entry);
    }
    const packChecksum = createHash("sha1").update(bytes("fake pack body")).digest();
    const idxData = idx.build(packChecksum);

    const reader = createPackIndexReader(idxData);
    expect(reader.objectCount).toBe(1);
    const hash = entries[0]!.hash;
    expect(reader.has(hash)).toBe(true);
    expect(reader.lookup(hash)!.offset).toBe(12);
  });
});
