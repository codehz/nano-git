/**
 * MIDX reachability bitmap 辅助函数单元测试
 */

import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import { addReachableFromCommitBitmap, findMidxObjectPosition } from "@/pack/midx-bitmap.ts";

import type { SHA1 } from "@/core/types.ts";
import type { UnpackedBitmap } from "@/pack/ewah-bitmap.ts";
import type { MidxReader } from "@/pack/midx-types.ts";
import type { PackBitmapReader } from "@/pack/pack-bitmap-reader.ts";

function createUnpacked(bits: boolean[]): UnpackedBitmap {
  return {
    bitCount: bits.length,
    get(bitIndex: number): boolean {
      return bits[bitIndex] ?? false;
    },
    or(other: UnpackedBitmap): UnpackedBitmap {
      const len = Math.max(bits.length, other.bitCount);
      const merged: boolean[] = [];
      for (let i = 0; i < len; i++) {
        merged.push((bits[i] ?? false) || other.get(i));
      }
      return createUnpacked(merged);
    },
  };
}

function stubMidxReader(hashes: SHA1[], revindex?: readonly number[]): MidxReader {
  const header = {
    version: 1,
    oidVersion: 1,
    chunkCount: 0,
    baseMidxCount: 0,
    packCount: 1,
  };
  return {
    header,
    objectCount: hashes.length,
    globalPackCount: 1,
    lookup: () => undefined,
    has: () => false,
    listHashes: () => [...hashes],
    getPackName: () => "pack-stub.pack",
    getRevindexPseudoPackOrder: revindex ? () => revindex : undefined,
  };
}

function stubBitmapReader(
  commitMidxPosition: number,
  reachability: UnpackedBitmap,
): PackBitmapReader {
  const empty = createUnpacked([]);
  return {
    checksumHex: "c".repeat(40),
    entryCount: 1,
    bitCount: reachability.bitCount,
    getTypeBitmap: () => empty,
    getReachabilityBitmap(pos: number): UnpackedBitmap | undefined {
      return pos === commitMidxPosition ? reachability : undefined;
    },
  };
}

describe("findMidxObjectPosition", () => {
  test("按 MIDX 全局序返回下标", () => {
    const h0 = sha1("a".repeat(40));
    const h1 = sha1("b".repeat(40));
    const midx = stubMidxReader([h0, h1]);
    expect(findMidxObjectPosition(midx, h1)).toBe(1);
    expect(findMidxObjectPosition(midx, sha1("f".repeat(40)))).toBeUndefined();
  });
});

describe("addReachableFromCommitBitmap", () => {
  const h0 = sha1("0".repeat(40));
  const h1 = sha1("1".repeat(40));
  const h2 = sha1("2".repeat(40));
  const commit = h0;

  test("无 RIDX 时位下标与 listHashes 下标一一对应", () => {
    const midx = stubMidxReader([h0, h1, h2]);
    const bits = createUnpacked([true, false, true]);
    const bitmap = stubBitmapReader(0, bits);
    const reachable = new Set<SHA1>();

    expect(addReachableFromCommitBitmap(midx, bitmap, commit, reachable)).toBe(true);
    expect(reachable.size).toBe(2);
    expect(reachable.has(h0)).toBe(true);
    expect(reachable.has(h2)).toBe(true);
    expect(reachable.has(h1)).toBe(false);
  });

  test("有 RIDX 时按 pseudo → 全局下标映射（非恒等排列）", () => {
    // pseudo 0 → global 1（h1）；若误用「global g 且 rev[g]=pseudo」会得到 h2
    const revindex = [1, 2, 0];
    const midx = stubMidxReader([h0, h1, h2], revindex);
    const bits = createUnpacked([true, false, false]);
    const bitmap = stubBitmapReader(0, bits);
    const reachable = new Set<SHA1>();

    expect(addReachableFromCommitBitmap(midx, bitmap, commit, reachable)).toBe(true);
    expect([...reachable]).toEqual([h1]);
  });

  test("RIDX 下多个 pseudo 位展开为对应全局对象", () => {
    const revindex = [2, 0, 1];
    const midx = stubMidxReader([h0, h1, h2], revindex);
    const bits = createUnpacked([true, false, true]);
    const bitmap = stubBitmapReader(0, bits);
    const reachable = new Set<SHA1>();

    addReachableFromCommitBitmap(midx, bitmap, commit, reachable);
    expect(reachable.has(h2)).toBe(true);
    expect(reachable.has(h1)).toBe(true);
    expect(reachable.has(h0)).toBe(false);
  });

  test("commit 不在 MIDX 序中返回 false", () => {
    const midx = stubMidxReader([h1, h2]);
    const bitmap = stubBitmapReader(0, createUnpacked([true]));
    const reachable = new Set<SHA1>();

    expect(addReachableFromCommitBitmap(midx, bitmap, commit, reachable)).toBe(false);
    expect(reachable.size).toBe(0);
  });

  test("无该 commit 的 bitmap 条目返回 false", () => {
    const midx = stubMidxReader([h0, h1]);
    const bitmap = stubBitmapReader(1, createUnpacked([true]));
    const reachable = new Set<SHA1>();

    expect(addReachableFromCommitBitmap(midx, bitmap, commit, reachable)).toBe(false);
    expect(reachable.size).toBe(0);
  });
});
