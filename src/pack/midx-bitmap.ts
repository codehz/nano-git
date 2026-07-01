/**
 * MIDX 链顶 reachability bitmap 加载与可达性辅助
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadIncrementalMidxChain } from "./midx-chain.ts";
import { createMidxReader } from "./midx-reader.ts";
import { createPackBitmapReader } from "./pack-bitmap-reader.ts";

import type { SHA1 } from "../core/types.ts";
import type { MidxReader } from "./midx-types.ts";
import type { PackBitmapReader } from "./pack-bitmap-reader.ts";

const CHAIN_DIR = "multi-pack-index.d";

/**
 * 解析链顶 MIDX 校验和（增量链 tip 或经典 `multi-pack-index` trailer）
 */
export function resolveMidxTipChecksumHex(packDir: string): string | undefined {
  const midx = loadIncrementalMidxChain(packDir, { expectedOidVersion: 1 });
  if (midx?.tipChecksumHex) {
    return midx.tipChecksumHex;
  }

  const classicPath = join(packDir, "multi-pack-index");
  if (!existsSync(classicPath)) {
    return undefined;
  }

  const data = readFileSync(classicPath);
  if (data.length < 20) {
    return undefined;
  }
  return data.subarray(data.length - 20).toString("hex");
}

/**
 * 加载与链顶 MIDX 关联的 `.bitmap` 文件（不存在或校验和不匹配时返回 undefined）
 */
export function tryLoadTipMidxBitmap(packDir: string): PackBitmapReader | undefined {
  const checksumHex = resolveMidxTipChecksumHex(packDir);
  if (!checksumHex) {
    return undefined;
  }

  const bitmapPath = join(packDir, CHAIN_DIR, `multi-pack-index-${checksumHex}.bitmap`);
  if (!existsSync(bitmapPath)) {
    const classicBitmap = join(packDir, `multi-pack-index-${checksumHex}.bitmap`);
    if (!existsSync(classicBitmap)) {
      return undefined;
    }
    return loadBitmapIfMatches(readFileSync(classicBitmap), checksumHex);
  }

  return loadBitmapIfMatches(readFileSync(bitmapPath), checksumHex);
}

function loadBitmapIfMatches(
  data: Buffer,
  expectedChecksumHex: string,
): PackBitmapReader | undefined {
  try {
    const reader = createPackBitmapReader(data);
    if (reader.checksumHex !== expectedChecksumHex) {
      return undefined;
    }
    return reader;
  } catch {
    return undefined;
  }
}

/**
 * 在 MIDX 全局 OID 序中查找对象位置
 */
export function findMidxObjectPosition(midx: MidxReader, hash: SHA1): number | undefined {
  const hashes = midx.listHashes();
  const index = hashes.indexOf(hash);
  return index >= 0 ? index : undefined;
}

/**
 * 将某 commit 的 reachability bitmap 中置位的对象加入集合
 *
 * @returns 是否成功使用了 bitmap（commit 有条目且已展开）
 */
export function addReachableFromCommitBitmap(
  midx: MidxReader,
  bitmap: PackBitmapReader,
  commitHash: SHA1,
  reachable: Set<SHA1>,
): boolean {
  const pos = findMidxObjectPosition(midx, commitHash);
  if (pos === undefined) {
    return false;
  }

  const bits = bitmap.getReachabilityBitmap(pos);
  if (!bits) {
    return false;
  }

  const hashes = midx.listHashes();
  const limit = Math.min(bits.bitCount, hashes.length);
  for (let i = 0; i < limit; i++) {
    if (bits.get(i)) {
      reachable.add(hashes[i]!);
    }
  }
  return true;
}

/**
 * 加载 pack 目录的 MIDX 读取器（经典或增量链）
 */
export function loadPackMidxReader(packDir: string): MidxReader | null {
  const chain = loadIncrementalMidxChain(packDir, { expectedOidVersion: 1 });
  if (chain) {
    return chain;
  }

  const classicPath = join(packDir, "multi-pack-index");
  if (!existsSync(classicPath)) {
    return null;
  }

  try {
    return createMidxReader(readFileSync(classicPath), { expectedOidVersion: 1 });
  } catch {
    return null;
  }
}
