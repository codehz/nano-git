/**
 * Packfile 索引文件读写测试
 */

import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import { createPackIndexReader, createPackIndexWriter } from "@/pack/pack-index.ts";

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
