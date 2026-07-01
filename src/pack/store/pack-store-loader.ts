/**
 * Pack 对象存储加载辅助函数
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createPackIndexReader } from "../idx/pack-index.ts";
import { loadIncrementalMidxChain } from "../midx/midx-chain.ts";
import { createMidxReader } from "../midx/midx-reader.ts";
import { PackReader } from "../reader/pack-reader.ts";

import type { MidxReader } from "../midx/midx-types.ts";
import type { PackFileInfo, PackPair, PackStoreLoadResult } from "./pack-store-types.ts";

/**
 * 扫描 pack 目录并加载索引信息
 *
 * 若目录下存在 `multi-pack-index`，会一并加载；
 * 未在 MIDX 中登记的 pack 仍会通过各自的 `.idx` 加载，作为回退。
 *
 * @param packDir - `.git/objects/pack` 目录
 * @returns 加载结果，包含 pack 文件对与可选的 MIDX 读取器
 *
 * @example
 * ```ts
 * const { pairs, midx } = loadPackPairs("/tmp/repo/.git/objects/pack");
 * ```
 */
export function loadPackPairs(packDir: string): PackStoreLoadResult {
  if (!existsSync(packDir)) {
    return { pairs: [], midx: null };
  }

  const pairs: PackPair[] = [];
  const files = readdirSync(packDir);
  const idxFiles = files.filter((file) => file.endsWith(".idx"));

  for (const idxFile of idxFiles) {
    const match = idxFile.match(/^pack-([0-9a-f]{40})\.idx$/);
    if (!match) {
      continue;
    }

    const checksum = match[1]!;
    const packFile = `pack-${checksum}.pack`;
    if (!existsSync(join(packDir, packFile))) {
      continue;
    }

    const idxData = readFileSync(join(packDir, idxFile));
    pairs.push({
      checksum,
      index: createPackIndexReader(idxData),
      reader: null,
      packData: null,
    });
  }

  // 加载 MIDX：经典单文件优先，否则尝试增量链
  const midxPath = join(packDir, "multi-pack-index");
  let midx: MidxReader | null = null;
  const midxOptions = { expectedOidVersion: 1 as const };
  if (existsSync(midxPath)) {
    try {
      const midxData = readFileSync(midxPath);
      midx = createMidxReader(midxData, midxOptions);
    } catch {
      midx = null;
    }
  } else {
    midx = loadIncrementalMidxChain(packDir, midxOptions);
  }

  return { pairs, midx };
}

/**
 * 按需加载 packfile 读取器
 *
 * @param packDir - `.git/objects/pack` 目录
 * @param pair - pack 文件对
 * @returns PackReader 实例
 *
 * @example
 * ```ts
 * const reader = getPackReader(packDir, pair);
 * ```
 */
export function getPackReader(packDir: string, pair: PackPair): PackReader {
  if (!pair.reader) {
    pair.packData = readFileSync(join(packDir, `pack-${pair.checksum}.pack`));
    pair.reader = new PackReader(pair.packData);
  }

  return pair.reader;
}

/**
 * 将 pack 文件对转换为对外展示信息
 *
 * @param packDir - `.git/objects/pack` 目录
 * @param pair - pack 文件对
 * @returns pack 文件信息
 *
 * @example
 * ```ts
 * const info = toPackFileInfo(packDir, pair);
 * ```
 */
export function toPackFileInfo(packDir: string, pair: PackPair): PackFileInfo {
  return {
    checksum: pair.checksum,
    packPath: join(packDir, `pack-${pair.checksum}.pack`),
    idxPath: join(packDir, `pack-${pair.checksum}.idx`),
    objectCount: pair.index.objectCount,
  };
}
