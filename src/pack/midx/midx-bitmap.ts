/**
 * MIDX 链顶 reachability bitmap 文件加载
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { bytesToHex, toUint8Array } from "../../bytes.ts";
import { createPackBitmapReader } from "../bitmap/pack-bitmap-reader.ts";
import { loadIncrementalMidxChain } from "./midx-chain.ts";
import { createMidxReader } from "./midx-reader.ts";

import type { PackBitmapReader } from "../bitmap/pack-bitmap-reader.ts";
import type { MidxReader } from "./midx-types.ts";

export {
  addReachableFromCommitBitmap,
  createMidxReachabilityAccelerator,
  findMidxObjectPosition,
} from "./midx-bitmap-core.ts";
export type { MidxBitmapAssist } from "./midx-bitmap-core.ts";

const CHAIN_DIR = "multi-pack-index.d";

/**
 * 解析链顶 MIDX 校验和（增量链 tip 或经典 `multi-pack-index` trailer）
 *
 * @param packDir - pack 目录
 * @returns MIDX 校验和，不存在时返回 undefined
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
  return bytesToHex(data.subarray(data.length - 20));
}

/**
 * 加载与链顶 MIDX 关联的 `.bitmap` 文件
 *
 * @param packDir - pack 目录
 * @returns bitmap 读取器，不存在或校验和不匹配时返回 undefined
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
  data: Uint8Array,
  expectedChecksumHex: string,
): PackBitmapReader | undefined {
  try {
    const reader = createPackBitmapReader(data);
    return reader.checksumHex === expectedChecksumHex ? reader : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 加载 pack 目录的 MIDX 读取器（经典或增量链）
 *
 * @param packDir - pack 目录
 * @returns MIDX 读取器，不存在或损坏时返回 null
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

/**
 * 若 pack 目录存在链顶 MIDX 与匹配 bitmap，则返回辅助对象
 *
 * @param packDir - pack 目录
 * @returns 已加载的 MIDX 与 bitmap
 */
export function tryLoadMidxBitmapAssist(packDir: string) {
  const midx = loadPackMidxReader(packDir);
  if (!midx) {
    return undefined;
  }
  const bitmap = tryLoadTipMidxBitmap(packDir);
  if (!bitmap) {
    return undefined;
  }
  return { midx, bitmap };
}
