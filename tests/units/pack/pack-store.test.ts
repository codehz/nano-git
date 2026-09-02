/**
 * PackObjectStore 单元测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allocBytes,
  asciiToBytes,
  bytes,
  bytesToUtf8,
  concatBytes,
  copyBytes,
  hexToBytes,
  writeU32BE,
  writeU64BE,
  writeU8,
} from "../../helpers/bytes.ts";
import { encodeObject } from "@/objects/raw.ts";
import { createPackBuilder } from "@/pack/builder/pack-builder.ts";
import { createPackObjectStore } from "@/pack/store/pack-store.ts";

import type { GitBlob } from "@/types/index.ts";

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
    const blob: GitBlob = { type: "blob", content: bytes("test content") };
    const hash = builder.addRaw(encodeObject(blob));
    builder.build();

    // 读取
    const store = createPackObjectStore(gitDir);
    expect(store.exists(hash)).toBe(true);

    const obj = store.read(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(bytesToUtf8(obj.content)).toBe("test content");
    }
  });

  test("支持从多个 packfile 读取对象", () => {
    const gitDir = tempDir;
    mkdirSync(join(gitDir, "objects", "pack"), { recursive: true });

    const builder1 = createPackBuilder(gitDir);
    const hash1 = builder1.addRaw(encodeObject({ type: "blob", content: bytes("pack one") }));
    builder1.build();

    const builder2 = createPackBuilder(gitDir);
    const hash2 = builder2.addRaw(encodeObject({ type: "blob", content: bytes("pack two") }));
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
      expect(bytesToUtf8(obj1.content)).toBe("pack one");
    }
    if (obj2.type === "blob") {
      expect(bytesToUtf8(obj2.content)).toBe("pack two");
    }
  });

  test("PackObjectStore 只提供读取接口", () => {
    const gitDir = tempDir;
    const store = createPackObjectStore(gitDir);

    expect("write" in store).toBe(false);
  });

  test("refresh() 后能看到新增的 packfile", () => {
    const gitDir = tempDir;
    mkdirSync(join(gitDir, "objects", "pack"), { recursive: true });

    const store = createPackObjectStore(gitDir);
    expect(store.packCount).toBe(0);

    const builder = createPackBuilder(gitDir);
    builder.addRaw(encodeObject({ type: "blob", content: bytes("after refresh") }));
    builder.build();

    store.refresh();
    expect(store.packCount).toBe(1);
  });

  test("存在 MIDX 时未纳入 MIDX 的 pack 仍可回退读取", () => {
    const gitDir = tempDir;
    mkdirSync(join(gitDir, "objects", "pack"), { recursive: true });

    // pack A：会被纳入 MIDX
    const builderA = createPackBuilder(gitDir);
    const hashA = builderA.addRaw(encodeObject({ type: "blob", content: bytes("in midx") }));
    const resultA = builderA.build();

    // pack B：不纳入 MIDX（手动构造只覆盖 pack A 的 MIDX）
    const builderB = createPackBuilder(gitDir);
    const hashB = builderB.addRaw(encodeObject({ type: "blob", content: bytes("not in midx") }));
    builderB.build();

    // 构造一个只包含 pack A 的合法 MIDX v1
    const checksumA = resultA.checksum;
    const pnam = asciiToBytes(`pack-${checksumA}.pack\0`);
    const pnamPadding = allocBytes((4 - (pnam.length % 4)) % 4);
    const oidf = allocBytes(256 * 4);
    // 对象首字节为 0xea = 234，fanout[234..255] 应为 1
    for (let i = 234; i < 256; i++) {
      writeU32BE(oidf, i * 4, 1);
    }
    const oidl = hexToBytes(hashA);
    const ooff = allocBytes(8);
    writeU32BE(ooff, 0, 0); // packId = 0
    writeU32BE(ooff, 4, 12); // offset = 12（pack 头之后）

    const chunks = [
      { id: "PNAM", data: concatBytes(pnam, pnamPadding) },
      { id: "OIDF", data: oidf },
      { id: "OIDL", data: oidl },
      { id: "OOFF", data: ooff },
    ];

    const header = allocBytes(12);
    copyBytes(header, 0, asciiToBytes("MIDX"));
    writeU8(header, 4, 1); // version
    writeU8(header, 5, 1); // oidVersion = SHA-1
    writeU8(header, 6, chunks.length);
    writeU8(header, 7, 0);
    writeU32BE(header, 8, 1); // packCount = 1

    const lookupSize = (chunks.length + 1) * 12;
    const lookup = allocBytes(lookupSize);
    let chunkOffset = 12 + lookupSize;
    for (let i = 0; i < chunks.length; i++) {
      copyBytes(lookup, i * 12, asciiToBytes(chunks[i]!.id));
      writeU64BE(lookup, i * 12 + 4, BigInt(chunkOffset));
      chunkOffset += chunks[i]!.data.length;
    }

    const bodyChunks = chunks.map((c) => c.data);
    const body = concatBytes(header, lookup, ...bodyChunks);

    // 写入 MIDX（无 trailer 校验和，策略与 idx 一致）
    writeFileSync(join(gitDir, "objects", "pack", "multi-pack-index"), body);

    const store = createPackObjectStore(gitDir);

    // MIDX 覆盖 pack A
    expect(store.exists(hashA)).toBe(true);
    const objA = store.read(hashA);
    expect(objA.type).toBe("blob");
    if (objA.type === "blob") {
      expect(bytesToUtf8(objA.content)).toBe("in midx");
    }

    // pack B 未纳入 MIDX，应通过 idx 回退读取
    expect(store.exists(hashB)).toBe(true);
    const objB = store.read(hashB);
    expect(objB.type).toBe("blob");
    if (objB.type === "blob") {
      expect(bytesToUtf8(objB.content)).toBe("not in midx");
    }

    // objectCount 应为 MIDX 对象数 + 未覆盖 pack 对象数
    expect(store.objectCount).toBe(2);
  });
});
