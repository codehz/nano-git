/**
 * midx/midx-layer.ts 单元测试
 */

import { describe, test, expect } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PackIndexError } from "@/errors.ts";
import { encodeObject } from "@/objects/raw.ts";
import { createPackBuilder } from "@/pack/builder/pack-builder.ts";
import {
  parseMidxLayer,
  linkMidxLayerToBase,
  createMidxReaderFromTip,
} from "@/pack/midx/midx-layer.ts";
import { writeMultiPackIndex } from "@/pack/midx/midx-writer.ts";
import { loadPackPairs } from "@/pack/store/pack-store-loader.ts";
import { sha1 } from "@/types/index.ts";

import type { GitBlob, SHA1 } from "@/types/index.ts";

describe("parseMidxLayer()", () => {
  test("非法签名抛出 PackIndexError", () => {
    expect(() => parseMidxLayer(Buffer.from("XXXX"))).toThrow(PackIndexError);
  });

  test("数据过小抛出 PackIndexError", () => {
    expect(() => parseMidxLayer(Buffer.from("MIDX"))).toThrow(PackIndexError);
  });

  test("不支持的 version 抛出 PackIndexError", () => {
    const header = Buffer.alloc(12);
    header.write("MIDX", 0);
    header.writeUInt8(0, 4); // version = 0
    header.writeUInt8(1, 5); // oidVersion = SHA-1
    header.writeUInt8(0, 6); // chunkCount
    header.writeUInt8(0, 7); // baseMidxCount
    header.writeUInt32BE(0, 8); // packCount
    expect(() => parseMidxLayer(header)).toThrow(PackIndexError);
  });

  test("不支持的 OID version 抛出 PackIndexError", () => {
    const header = Buffer.alloc(12);
    header.write("MIDX", 0);
    header.writeUInt8(1, 4); // version = 1
    header.writeUInt8(3, 5); // oidVersion = 3 (invalid)
    header.writeUInt8(0, 6);
    header.writeUInt8(0, 7);
    header.writeUInt32BE(0, 8);
    expect(() => parseMidxLayer(header)).toThrow(PackIndexError);
  });

  test("OID version 与预期不匹配时抛出 PackIndexError", () => {
    const header = Buffer.alloc(12);
    header.write("MIDX", 0);
    header.writeUInt8(1, 4); // version = 1
    header.writeUInt8(2, 5); // oidVersion = 2 (SHA-256)
    header.writeUInt8(0, 6);
    header.writeUInt8(0, 7);
    header.writeUInt32BE(0, 8);
    // 默认期望 SHA-1 (oidVersion=1)，不匹配
    expect(() => parseMidxLayer(header)).toThrow(PackIndexError);
  });

  test("缺少必需 chunk 时抛出 PackIndexError", () => {
    // 构造一个只有 MIDX 头部 + 空 chunk lookup 表的数据
    // 头部 + 1 项 chunk lookup (12 bytes) + checksum
    const midxSig = Buffer.from("MIDX");
    const header = Buffer.alloc(12);
    midxSig.copy(header, 0);
    header.writeUInt8(1, 4); // version
    header.writeUInt8(1, 5); // oidVersion
    header.writeUInt8(0, 6); // chunkCount = 0
    header.writeUInt8(0, 7); // baseMidxCount
    header.writeUInt32BE(1, 8); // packCount

    const lookupSize = (0 + 1) * 12; // chunkCount=0, so 1 terminator entry
    const totalSize = 12 + lookupSize + 20; // + 20 for SHA-1 trailer
    const data = Buffer.alloc(totalSize, 0);
    header.copy(data, 0);
    // lookup 表全部为零（终止标记）

    expect(() => parseMidxLayer(data)).toThrow(PackIndexError);
  });
});

describe("parseMidxLayer + createMidxReaderFromTip", () => {
  function buildSinglePackMidx(): {
    midxData: Buffer;
    hashes: SHA1[];
    cleanup: () => void;
  } {
    const tempDir = join(tmpdir(), `midx-layer-${Date.now()}`);
    const gitDir = join(tempDir, ".git");
    const packDir = join(gitDir, "objects", "pack");
    mkdirSync(packDir, { recursive: true });

    const hashes: SHA1[] = [];
    const builder = createPackBuilder(gitDir);
    const blob: GitBlob = { type: "blob", content: Buffer.from("midx layer test") };
    const hash = builder.addRaw(encodeObject(blob));
    builder.build();
    hashes.push(hash);

    const { pairs } = loadPackPairs(packDir);
    const midxData = writeMultiPackIndex(
      [{ packChecksum: pairs[0]!.checksum, index: pairs[0]!.index }],
      { version: 2 },
    );

    const cleanup = (): void => {
      if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
    };

    return { midxData, hashes, cleanup };
  }

  test("解析单包 MIDX 并校验 lookup/has", () => {
    const { midxData, hashes, cleanup } = buildSinglePackMidx();
    try {
      const layer = parseMidxLayer(midxData);
      expect(layer.header.version).toBe(2);
      expect(layer.header.oidVersion).toBe(1);
      expect(layer.header.chunkCount).toBeGreaterThanOrEqual(4);
      expect(layer.header.packCount).toBe(1);
      expect(layer.layerObjectCount).toBe(1);
      expect(layer.layerPackCount).toBe(1);
      expect(layer.fileChecksumHex).toBeDefined();

      const hit = layer.lookupInLayer(hashes[0]!);
      expect(hit).toBeDefined();
      expect(hit!.localPackId).toBe(0);
      expect(hit!.offset).toBeGreaterThan(0);

      expect(layer.lookupInLayer(sha1("0000000000000000000000000000000000000000"))).toBeUndefined();

      const hashAt0 = layer.getHashAtLayerIndex(0);
      expect(hashAt0).toBe(hashes[0]!);

      const entry = layer.getEntryAtLayerIndex(0);
      expect(entry.hash).toBe(hashes[0]!);
      expect(entry.packId).toBe(0);

      const packName = layer.getLocalPackName(0);
      expect(packName).toMatch(/^pack-.*\.idx$/);
    } finally {
      cleanup();
    }
  });

  test("createMidxReaderFromTip 单层通过 lookup 读到对象", () => {
    const { midxData, hashes, cleanup } = buildSinglePackMidx();
    try {
      const layer = parseMidxLayer(midxData);
      const reader = createMidxReaderFromTip(layer);

      expect(reader.objectCount).toBe(1);
      expect(reader.globalPackCount).toBe(1);
      expect(reader.header.version).toBe(2);

      const entry = reader.lookup(hashes[0]!);
      expect(entry).toBeDefined();
      expect(entry!.packId).toBe(0);

      expect(reader.has(hashes[0]!)).toBe(true);
      expect(reader.has(sha1("0000000000000000000000000000000000000000"))).toBe(false);

      expect(reader.getPackName(0)).toMatch(/^pack-.*\.idx$/);

      const allHashes = reader.listHashes();
      expect(allHashes).toHaveLength(1);
      expect(allHashes[0]).toBe(hashes[0]!);
    } finally {
      cleanup();
    }
  });

  test("linkMidxLayerToBase 链接两层", () => {
    const tempDir = join(tmpdir(), `midx-layer-chain-${Date.now()}`);
    const gitDir = join(tempDir, ".git");
    const packDir = join(gitDir, "objects", "pack");
    mkdirSync(packDir, { recursive: true });

    try {
      const builder1 = createPackBuilder(gitDir);
      const blob1: GitBlob = { type: "blob", content: Buffer.from("layer a") };
      const hash1 = builder1.addRaw(encodeObject(blob1));
      builder1.build();

      const builder2 = createPackBuilder(gitDir);
      const blob2: GitBlob = { type: "blob", content: Buffer.from("layer b") };
      const hash2 = builder2.addRaw(encodeObject(blob2));
      builder2.build();

      const { pairs } = loadPackPairs(packDir);
      expect(pairs.length).toBe(2);

      // 构造两个独立 MIDX 层
      const midx1 = writeMultiPackIndex(
        [{ packChecksum: pairs[0]!.checksum, index: pairs[0]!.index }],
        { version: 2 },
      );
      const midx2 = writeMultiPackIndex(
        [{ packChecksum: pairs[1]!.checksum, index: pairs[1]!.index }],
        { version: 2 },
      );

      const layer1 = parseMidxLayer(midx1);
      const layer2 = parseMidxLayer(midx2);

      // 链接：layer2 (tip) -> layer1 (base)
      linkMidxLayerToBase(layer2, layer1);

      expect(layer2.base).toBe(layer1);
      expect(layer2.numPacksInBase).toBe(1);
      expect(layer2.numObjectsInBase).toBe(1);

      const reader = createMidxReaderFromTip(layer2);
      expect(reader.objectCount).toBe(2);
      expect(reader.globalPackCount).toBe(2);

      // 两个对象都应能查到
      expect(reader.has(hash1)).toBe(true);
      expect(reader.has(hash2)).toBe(true);

      // packId 是全局的：base 层的 pack 在 layer1（packId=0），tip 层在 layer2（packId=1）
      // 但由于 writeMultiPackIndex 按 PNAM 排序，实际 packId 取决于文件名排序
      // 这里只验证能找到对象即可，不假设具体 packId
      const entry1 = reader.lookup(hash1);
      expect(entry1).toBeDefined();
      expect(typeof entry1!.packId).toBe("number");

      const entry2 = reader.lookup(hash2);
      expect(entry2).toBeDefined();
      expect(typeof entry2!.packId).toBe("number");

      // packId 应该各不相同（因为两个对象来自不同 pack）
      expect(entry1!.packId).not.toBe(entry2!.packId);

      const allHashes = reader.listHashes();
      expect(allHashes).toHaveLength(2);
      expect(allHashes).toContain(hash1);
      expect(allHashes).toContain(hash2);
    } finally {
      if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
    }
  });
});
