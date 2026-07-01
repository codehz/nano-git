/**
 * 增量 MIDX 链单元测试
 */

import { describe, test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeObject } from "@/objects/raw.ts";
import { loadIncrementalMidxChain, tryLoadMidxChainTip } from "@/pack/midx-chain.ts";
import { writeMultiPackIndex, writeIncrementalMultiPackIndexFile } from "@/pack/midx-writer.ts";
import { createPackBuilder } from "@/pack/pack-builder.ts";
import { loadPackPairs } from "@/pack/pack-store-loader.ts";

import type { GitBlob } from "@/core/types.ts";

describe("loadIncrementalMidxChain", () => {
  test("无 chain 目录时返回 null", () => {
    const dir = join(tmpdir(), `midx-chain-missing-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      expect(loadIncrementalMidxChain(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("损坏的 chain 行导致返回 null", () => {
    const packDir = join(tmpdir(), `midx-chain-bad-${Date.now()}`, "pack");
    const chainDir = join(packDir, "multi-pack-index.d");
    mkdirSync(chainDir, { recursive: true });
    writeFileSync(join(chainDir, "multi-pack-index-chain"), "not-a-hash\n");
    try {
      expect(tryLoadMidxChainTip(packDir)).toBeNull();
    } finally {
      rmSync(join(packDir, ".."), { recursive: true, force: true });
    }
  });

  test("两层链 round-trip：各层仅含一个 pack", () => {
    const root = join(tmpdir(), `midx-chain-rt-${Date.now()}`);
    const gitDir = join(root, ".git");
    const packDir = join(gitDir, "objects", "pack");
    mkdirSync(packDir, { recursive: true });

    const builder1 = createPackBuilder(gitDir);
    const blob1: GitBlob = { type: "blob", content: Buffer.from("base layer") };
    const hash1 = builder1.addRaw(encodeObject(blob1));
    builder1.build();

    const builder2 = createPackBuilder(gitDir);
    const blob2: GitBlob = { type: "blob", content: Buffer.from("tip layer only") };
    const hash2 = builder2.addRaw(encodeObject(blob2));
    builder2.build();

    const { pairs } = loadPackPairs(packDir);
    expect(pairs.length).toBe(2);

    const baseMidx = writeMultiPackIndex(
      [{ packChecksum: pairs[0]!.checksum, index: pairs[0]!.index }],
      { version: 2 },
    );
    const tipMidx = writeMultiPackIndex(
      [{ packChecksum: pairs[1]!.checksum, index: pairs[1]!.index }],
      { version: 2 },
    );

    const baseId = baseMidx.subarray(baseMidx.length - 20).toString("hex");
    const tipId = tipMidx.subarray(tipMidx.length - 20).toString("hex");

    const chainDir = join(packDir, "multi-pack-index.d");
    mkdirSync(chainDir, { recursive: true });
    writeFileSync(join(chainDir, `multi-pack-index-${baseId}.midx`), baseMidx);
    writeFileSync(join(chainDir, `multi-pack-index-${tipId}.midx`), tipMidx);
    writeFileSync(join(chainDir, "multi-pack-index-chain"), `${baseId}\n${tipId}\n`);

    try {
      const midx = loadIncrementalMidxChain(packDir, { expectedOidVersion: 1 });
      expect(midx).not.toBeNull();
      expect(midx!.globalPackCount).toBe(2);
      expect(midx!.objectCount).toBe(2);
      expect(midx!.lookup(hash1)).toBeDefined();
      expect(midx!.lookup(hash2)).toBeDefined();

      const { midx: loaded } = loadPackPairs(packDir);
      expect(loaded!.objectCount).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writeIncrementalMultiPackIndexFile 追加新 pack 层", () => {
    const root = join(tmpdir(), `midx-inc-write-${Date.now()}`);
    const gitDir = join(root, ".git");
    const packDir = join(gitDir, "objects", "pack");
    mkdirSync(packDir, { recursive: true });

    const builder1 = createPackBuilder(gitDir);
    const blob1: GitBlob = { type: "blob", content: Buffer.from("inc base") };
    const hash1 = builder1.addRaw(encodeObject(blob1));
    builder1.build();

    writeIncrementalMultiPackIndexFile(packDir, { version: 2 });

    const builder2 = createPackBuilder(gitDir);
    const blob2: GitBlob = { type: "blob", content: Buffer.from("inc tip") };
    const hash2 = builder2.addRaw(encodeObject(blob2));
    builder2.build();

    writeIncrementalMultiPackIndexFile(packDir, { version: 2 });

    const midx = loadIncrementalMidxChain(packDir, { expectedOidVersion: 1 });
    expect(midx).not.toBeNull();
    expect(midx!.globalPackCount).toBe(2);
    expect(midx!.lookup(hash1)).toBeDefined();
    expect(midx!.lookup(hash2)).toBeDefined();
    rmSync(root, { recursive: true, force: true });
  });
});
