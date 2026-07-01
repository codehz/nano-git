/**
 * pack/pack-store-loader.ts 单元测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha1 } from "@/core/types.ts";
import { createPackIndexWriter } from "@/pack/pack-index.ts";
import { loadPackPairs } from "@/pack/pack-store-loader.ts";

describe("loadPackPairs()", () => {
  let packDir: string;

  beforeEach(() => {
    packDir = join(tmpdir(), `nano-git-packload-${Date.now()}-${Math.random()}`);
    mkdirSync(packDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(packDir)) {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  test("不存在的目录返回空结果", () => {
    const badDir = join(packDir, "nonexistent");
    const result = loadPackPairs(badDir);
    expect(result.pairs).toEqual([]);
    expect(result.midx).toBeNull();
  });

  test("空目录返回空结果", () => {
    const result = loadPackPairs(packDir);
    expect(result.pairs).toEqual([]);
    expect(result.midx).toBeNull();
  });

  test("只包含 .pack 文件没有 .idx 文件时返回空结果", () => {
    writeFileSync(join(packDir, "pack-abc123.pack"), "fake pack data");
    const result = loadPackPairs(packDir);
    expect(result.pairs).toEqual([]);
    expect(result.midx).toBeNull();
  });

  test("只包含 .idx 文件没有 .pack 文件时返回空结果", () => {
    writeFileSync(join(packDir, "pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx"), "fake idx");
    const result = loadPackPairs(packDir);
    expect(result.pairs).toEqual([]);
    expect(result.midx).toBeNull();
  });

  test("加载匹配的 pack/idx 对", () => {
    const checksum = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    // 构建一个合法的 v2 索引文件
    const writer = createPackIndexWriter();
    writer.addEntry({
      hash: sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"),
      offset: 12,
      crc32: 12345,
    });
    const idxData = writer.build(Buffer.alloc(20)); // packChecksum = 20 zero bytes

    writeFileSync(join(packDir, `pack-${checksum}.idx`), idxData);
    writeFileSync(join(packDir, `pack-${checksum}.pack`), "fake pack");

    const { pairs } = loadPackPairs(packDir);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.checksum).toBe(checksum);
    expect(pairs[0]!.reader).toBeNull();
    expect(pairs[0]!.packData).toBeNull();
    expect(pairs[0]!.index).toBeDefined();
  });

  test("跳过不匹配的 pack 文件名格式", () => {
    writeFileSync(join(packDir, "pack-bad-name.idx"), "fake");
    writeFileSync(join(packDir, "pack-bad-name.pack"), "fake");

    const { pairs } = loadPackPairs(packDir);
    expect(pairs).toHaveLength(0);
  });
});
