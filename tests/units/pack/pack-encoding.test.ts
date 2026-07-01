/**
 * pack/pack-encoding.ts 单元测试
 */

import { describe, test, expect } from "bun:test";

import { encodeObject } from "@/objects/raw.ts";
import { toEncodedPackObject, buildEncodedPack } from "@/pack/writer/pack-encoding.ts";
import { sha1, type GitBlob } from "@/types/index.ts";

describe("toEncodedPackObject()", () => {
  test("将 blob 对象转换为编码条目", () => {
    const blob: GitBlob = { type: "blob", content: Buffer.from("hello world") };
    const entry = toEncodedPackObject(encodeObject(blob));

    expect(entry.type).toBe("blob");
    expect(entry.hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));
    expect(entry.data).toBeDefined();
    expect(entry.data.length).toBeGreaterThan(0);
  });
});

describe("buildEncodedPack()", () => {
  test("构建包含单个对象的 packfile", () => {
    const blob: GitBlob = { type: "blob", content: Buffer.from("hello world") };
    const entry = toEncodedPackObject(encodeObject(blob));
    const result = buildEncodedPack([entry]);

    // 验证 pack header (12 bytes) + object data
    expect(result.packData.length).toBeGreaterThan(12);
    // 验证 checksum (20 bytes at the end)
    expect(result.packChecksum).toHaveLength(20);
    // 验证索引条目
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.hash).toBe(entry.hash);
    expect(result.entries[0]!.offset).toBe(12); // 12 bytes for pack header
    expect(typeof result.entries[0]!.crc32).toBe("number");
  });

  test("构建包含多个对象的 packfile", () => {
    const objects: GitBlob[] = [
      { type: "blob", content: Buffer.from("first") },
      { type: "blob", content: Buffer.from("second") },
      { type: "blob", content: Buffer.from("third") },
    ];
    const entries = objects.map((o) => toEncodedPackObject(encodeObject(o)));
    const result = buildEncodedPack(entries);

    expect(result.entries).toHaveLength(3);
    // 验证偏移量递增
    for (let i = 1; i < result.entries.length; i++) {
      expect(result.entries[i]!.offset).toBeGreaterThan(result.entries[i - 1]!.offset);
    }
  });
});
