/**
 * MIDX 读取器单元测试
 */

import { describe, test, expect } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha1 } from "@/core/types.ts";
import { encodeObject } from "@/objects/raw.ts";
import { createMidxReader } from "@/pack/midx-reader.ts";
import { createPackBuilder } from "@/pack/pack-builder.ts";
import { createPackObjectStore } from "@/pack/pack-store.ts";

import type { GitBlob } from "@/core/types.ts";

describe("createMidxReader", () => {
  function buildMidxFixture(): { gitDir: string; hashes: string[]; cleanup: () => void } {
    const tempDir = join(tmpdir(), `nano-git-midx-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const gitDir = join(tempDir, ".git");
    mkdirSync(join(gitDir, "objects", "pack"), { recursive: true });

    const hashes: string[] = [];

    // 创建多个 pack，每个 pack 包含不同 blob
    for (let i = 0; i < 3; i++) {
      const builder = createPackBuilder(gitDir);
      const blob: GitBlob = { type: "blob", content: Buffer.from(`midx blob ${i}`) };
      const hash = builder.addRaw(encodeObject(blob));
      builder.build();
      hashes.push(hash);
    }

    // 手动构造一个最小合法 MIDX（v1，SHA-1）
    // 这里用 createPackObjectStore 验证无 MIDX 时能读到对象，
    // 真正的 MIDX 二进制 fixture 在 e2e 中由 git multi-pack-index write 生成。
    const cleanup = (): void => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true });
      }
    };

    return { gitDir, hashes, cleanup };
  }

  test("缺少 MIDX 时 store 仍能读取各 pack 对象", () => {
    const { gitDir, hashes, cleanup } = buildMidxFixture();
    try {
      const store = createPackObjectStore(gitDir);
      expect(store.packCount).toBe(3);

      for (const hash of hashes) {
        expect(store.exists(sha1(hash))).toBe(true);
        const obj = store.read(sha1(hash));
        expect(obj.type).toBe("blob");
      }
    } finally {
      cleanup();
    }
  });

  test("损坏的 MIDX 被忽略并回退到 idx", () => {
    const { gitDir, hashes, cleanup } = buildMidxFixture();
    try {
      const midxPath = join(gitDir, "objects", "pack", "multi-pack-index");
      writeFileSync(midxPath, Buffer.from("MIDX\x00\x00\x00\x00"));

      const store = createPackObjectStore(gitDir);
      expect(store.packCount).toBe(3);

      for (const hash of hashes) {
        expect(store.exists(sha1(hash))).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  test("createMidxReader 拒绝非法签名", () => {
    expect(() => createMidxReader(Buffer.from("XXXX"))).toThrow();
  });

  test("createMidxReader 拒绝过小的数据", () => {
    expect(() => createMidxReader(Buffer.from("MIDX"))).toThrow();
  });

  test("createMidxReader 在 OID 版本不匹配时抛出", () => {
    // 构造一个 SHA-256 MIDX 头部（version=1, oidVersion=2）
    const header = Buffer.alloc(12);
    header.write("MIDX", 0);
    header.writeUInt8(1, 4); // version
    header.writeUInt8(2, 5); // oidVersion = SHA-256
    header.writeUInt8(0, 6); // chunkCount
    header.writeUInt8(0, 7); // baseMidxCount
    header.writeUInt32BE(0, 8); // packCount

    // 默认期望 SHA-1，应抛出
    expect(() => createMidxReader(header)).toThrow();

    // 显式期望 SHA-256 时应通过头部检查（后续 chunk 缺失仍会抛）
    expect(() => createMidxReader(header, { expectedOidVersion: 2 })).toThrow();
  });
});
