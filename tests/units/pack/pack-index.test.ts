/**
 * Packfile 索引文件读写测试
 */

import { describe, test, expect } from "bun:test";

import { PackIndexError } from "@/errors.ts";
import { IDX_V2_SIGNATURE, IDX_V2_HEADER_SIZE } from "@/pack/constants.ts";
import { createPackIndexReader, createPackIndexWriter } from "@/pack/idx/pack-index.ts";
import { sha1 } from "@/types/index.ts";

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

  test("has() 返回正确结果", () => {
    const writer = createPackIndexWriter();
    const hash = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    writer.addEntry({ hash, offset: 42, crc32: 0xdeadbeef });

    const idxData = writer.build(Buffer.alloc(20, 0xbb));
    const reader = createPackIndexReader(idxData);

    expect(reader.has(hash)).toBe(true);
    expect(reader.has(sha1("ffffffffffffffffffffffffffffffffffffffff"))).toBe(false);
  });

  test("listHashes() 列出所有哈希", () => {
    const writer = createPackIndexWriter();
    const hash1 = sha1("1111111111111111111111111111111111111111");
    const hash2 = sha1("2222222222222222222222222222222222222222");
    const hash3 = sha1("3333333333333333333333333333333333333333");

    writer.addEntry({ hash: hash1, offset: 10, crc32: 1 });
    writer.addEntry({ hash: hash2, offset: 20, crc32: 2 });
    writer.addEntry({ hash: hash3, offset: 30, crc32: 3 });

    const idxData = writer.build(Buffer.alloc(20, 0xcc));
    const reader = createPackIndexReader(idxData);

    const hashes = reader.listHashes();
    expect(hashes).toHaveLength(3);
    // 应有序排列
    expect(hashes[0]).toBe(hash1);
    expect(hashes[1]).toBe(hash2);
    expect(hashes[2]).toBe(hash3);
  });

  test("大偏移量（>= 2GB）正确读写", () => {
    const writer = createPackIndexWriter();
    const hash1 = sha1("1111111111111111111111111111111111111111");
    const hash2 = sha1("2222222222222222222222222222222222222222");

    writer.addEntry({ hash: hash1, offset: 0x7fffffff, crc32: 0x12345678 }); // 接近边界
    writer.addEntry({ hash: hash2, offset: 0x80000001, crc32: 0x87654321 }); // 需要大偏移量表

    const idxData = writer.build(Buffer.alloc(20, 0xdd));
    const reader = createPackIndexReader(idxData);

    expect(reader.objectCount).toBe(2);
    expect(reader.lookup(hash1)!.offset).toBe(0x7fffffff);
    expect(reader.lookup(hash2)!.offset).toBe(0x80000001);
  });

  test("无效签名抛出 PackIndexError", () => {
    const data = Buffer.alloc(100);
    expect(() => createPackIndexReader(data)).toThrow(PackIndexError);
  });

  test("不支持的 version 抛出 PackIndexError", () => {
    const data = Buffer.alloc(IDX_V2_HEADER_SIZE + 256 * 4 + 100);
    IDX_V2_SIGNATURE.copy(data, 0);
    data.writeUInt32BE(3, 4); // version = 3（不支持）
    expect(() => createPackIndexReader(data)).toThrow(PackIndexError);
  });

  test("idx 文件过小抛出 PackIndexError", () => {
    const data = Buffer.alloc(4); // 比 IDX_V2_HEADER_SIZE (8) 小
    expect(() => createPackIndexReader(data)).toThrow(PackIndexError);
  });
});
