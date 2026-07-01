/**
 * MIDX 写入器单元测试
 */

import { describe, test, expect } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeObject } from "@/objects/raw.ts";
import { createMidxReader } from "@/pack/midx-reader.ts";
import { writeMultiPackIndex, writeMultiPackIndexFile } from "@/pack/midx-writer.ts";
import { createPackBuilder } from "@/pack/pack-builder.ts";
import { loadPackPairs } from "@/pack/pack-store-loader.ts";
import { createPackObjectStore } from "@/pack/pack-store.ts";
import { sha1 } from "@/types/index.ts";

import type { GitBlob } from "@/types/index.ts";

describe("writeMultiPackIndex", () => {
  function buildMultiPackFixture(): {
    packDir: string;
    hashes: string[];
    cleanup: () => void;
  } {
    const tempDir = join(tmpdir(), `nano-git-midx-write-${Date.now()}`);
    const gitDir = join(tempDir, ".git");
    const packDir = join(gitDir, "objects", "pack");
    mkdirSync(packDir, { recursive: true });

    const hashes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const builder = createPackBuilder(gitDir);
      const blob: GitBlob = { type: "blob", content: Buffer.from(`write midx ${i}`) };
      const hash = builder.addRaw(encodeObject(blob));
      builder.build();
      hashes.push(hash);
    }

    const cleanup = (): void => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true });
      }
    };

    return { packDir, hashes, cleanup };
  }

  test("写入后可被 createMidxReader 解析且 lookup 一致", () => {
    const { packDir, hashes, cleanup } = buildMultiPackFixture();
    try {
      const { pairs } = loadPackPairs(packDir);
      const sources = pairs.map((pair) => ({
        packChecksum: pair.checksum,
        index: pair.index,
      }));

      const midxData = writeMultiPackIndex(sources);
      const midx = createMidxReader(midxData);

      expect(midx.objectCount).toBe(hashes.length);
      expect(midx.listHashes().length).toBe(hashes.length);

      for (const hex of hashes) {
        const hash = sha1(hex);
        const entry = midx.lookup(hash);
        expect(entry).toBeDefined();
        expect(entry!.hash).toBe(hash);
        expect(entry!.packId).toBeGreaterThanOrEqual(0);
        expect(entry!.offset).toBeGreaterThan(0);
      }
    } finally {
      cleanup();
    }
  });

  test("writeMultiPackIndexFile 接入 pack store", () => {
    const { packDir, hashes, cleanup } = buildMultiPackFixture();
    try {
      writeMultiPackIndexFile(packDir);

      const store = createPackObjectStore(join(packDir, "..", ".."));
      expect(store.objectCount).toBe(hashes.length);

      for (const hex of hashes) {
        expect(store.exists(sha1(hex))).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  test("空 pack 列表抛出", () => {
    expect(() => writeMultiPackIndex([])).toThrow();
  });
});
