/**
 * PackObjectStore 单元测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeObject } from "@/objects/raw.ts";
import { createPackBuilder } from "@/pack/pack-builder.ts";
import { createPackObjectStore } from "@/pack/pack-store.ts";

import type { GitBlob } from "@/core/types.ts";

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
    const hash = builder.addRaw(encodeObject(blob));
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
    const hash1 = builder1.addRaw(encodeObject({ type: "blob", content: Buffer.from("pack one") }));
    builder1.build();

    const builder2 = createPackBuilder(gitDir);
    const hash2 = builder2.addRaw(encodeObject({ type: "blob", content: Buffer.from("pack two") }));
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
    builder.addRaw(encodeObject({ type: "blob", content: Buffer.from("after refresh") }));
    builder.build();

    store.refresh();
    expect(store.packCount).toBe(1);
  });

  test("存在 MIDX 时未纳入 MIDX 的 pack 仍可回退读取", () => {
    const gitDir = tempDir;
    mkdirSync(join(gitDir, "objects", "pack"), { recursive: true });

    // pack A：会被纳入 MIDX
    const builderA = createPackBuilder(gitDir);
    const hashA = builderA.addRaw(encodeObject({ type: "blob", content: Buffer.from("in midx") }));
    const resultA = builderA.build();

    // pack B：不纳入 MIDX（手动构造只覆盖 pack A 的 MIDX）
    const builderB = createPackBuilder(gitDir);
    const hashB = builderB.addRaw(
      encodeObject({ type: "blob", content: Buffer.from("not in midx") }),
    );
    builderB.build();

    // 构造一个只包含 pack A 的合法 MIDX v1
    const checksumA = resultA.checksum;
    const pnam = Buffer.from(`pack-${checksumA}.pack\0`, "ascii");
    const pnamPadding = Buffer.alloc((4 - (pnam.length % 4)) % 4);
    const oidf = Buffer.alloc(256 * 4);
    // 对象首字节为 0xea = 234，fanout[234..255] 应为 1
    for (let i = 234; i < 256; i++) {
      oidf.writeUInt32BE(1, i * 4);
    }
    const oidl = Buffer.from(hashA, "hex");
    const ooff = Buffer.alloc(8);
    ooff.writeUInt32BE(0, 0); // packId = 0
    ooff.writeUInt32BE(12, 4); // offset = 12（pack 头之后）

    const chunks = [
      { id: "PNAM", data: Buffer.concat([pnam, pnamPadding]) },
      { id: "OIDF", data: oidf },
      { id: "OIDL", data: oidl },
      { id: "OOFF", data: ooff },
    ];

    const header = Buffer.alloc(12);
    header.write("MIDX", 0);
    header.writeUInt8(1, 4); // version
    header.writeUInt8(1, 5); // oidVersion = SHA-1
    header.writeUInt8(chunks.length, 6);
    header.writeUInt8(0, 7);
    header.writeUInt32BE(1, 8); // packCount = 1

    const lookupSize = (chunks.length + 1) * 12;
    const lookup = Buffer.alloc(lookupSize);
    let chunkOffset = 12 + lookupSize;
    for (let i = 0; i < chunks.length; i++) {
      lookup.write(chunks[i]!.id, i * 12);
      lookup.writeBigUInt64BE(BigInt(chunkOffset), i * 12 + 4);
      chunkOffset += chunks[i]!.data.length;
    }

    const bodyChunks = chunks.map((c) => c.data);
    const body = Buffer.concat([header, lookup, ...bodyChunks]);

    // 写入 MIDX（无 trailer 校验和，P0/P1 策略与 idx 一致）
    writeFileSync(join(gitDir, "objects", "pack", "multi-pack-index"), body);

    const store = createPackObjectStore(gitDir);

    // MIDX 覆盖 pack A
    expect(store.exists(hashA)).toBe(true);
    const objA = store.read(hashA);
    expect(objA.type).toBe("blob");
    if (objA.type === "blob") {
      expect(objA.content.toString("utf-8")).toBe("in midx");
    }

    // pack B 未纳入 MIDX，应通过 idx 回退读取
    expect(store.exists(hashB)).toBe(true);
    const objB = store.read(hashB);
    expect(objB.type).toBe("blob");
    if (objB.type === "blob") {
      expect(objB.content.toString("utf-8")).toBe("not in midx");
    }

    // objectCount 应为 MIDX 对象数 + 未覆盖 pack 对象数
    expect(store.objectCount).toBe(2);
  });
});
