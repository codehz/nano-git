/**
 * Pack 对象存储加载辅助函数
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PackIndexReader } from "./pack-index.ts";
import { PackReader } from "./pack-reader.ts";

import type { PackFileInfo, PackPair } from "./pack-store-types.ts";

/**
 * 扫描 pack 目录并加载索引信息
 *
 * @param packDir - `.git/objects/pack` 目录
 * @returns 已发现的 pack 文件对
 *
 * @example
 * ```ts
 * const pairs = loadPackPairs("/tmp/repo/.git/objects/pack");
 * ```
 */
export function loadPackPairs(packDir: string): PackPair[] {
  if (!existsSync(packDir)) {
    return [];
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
      index: new PackIndexReader(idxData),
      reader: null,
      packData: null,
    });
  }

  return pairs;
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
