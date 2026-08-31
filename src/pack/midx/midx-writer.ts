/**
 * Multi-Pack Index (MIDX) 写入
 *
 * 根据多个 pack 的 `.idx` 生成经典单文件 `multi-pack-index`（v1/v2，SHA-1）。
 *
 * @example
 * ```ts
 * const data = writeMultiPackIndex([
 *   { packFileName: "pack-abc.pack", index: idxReader },
 * ]);
 * writeFileSync(join(packDir, "multi-pack-index"), data);
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { PackIndexError } from "../../errors.ts";
import { loadPackPairs } from "../store/pack-store-loader.ts";
import { loadIncrementalMidxChain } from "./midx-chain.ts";
import { createMidxReader } from "./midx-reader.ts";
import { writeMultiPackIndex } from "./midx-writer-core.ts";

import type { SHA1 } from "../../types/index.ts";
import type { MidxPackSource, WriteMultiPackIndexOptions } from "./midx-writer-core.ts";

/**
 * 扫描 pack 目录并写入 `multi-pack-index`
 *
 * @param packDir - `.git/objects/pack` 目录
 * @returns 写入的文件内容
 *
 * @example
 * ```ts
 * writeMultiPackIndexFile(packDir);
 * const store = createPackObjectStore(gitDir);
 * store.refresh();
 * ```
 */
export function writeMultiPackIndexFile(
  packDir: string,
  options?: WriteMultiPackIndexOptions,
): Buffer {
  const { pairs } = loadPackPairs(packDir);
  if (pairs.length === 0) {
    throw new PackIndexError(`No pack pairs found in ${packDir}`, { path: packDir });
  }

  const sources: MidxPackSource[] = pairs.map((pair) => ({
    packChecksum: pair.checksum,
    index: pair.index,
  }));

  const data = writeMultiPackIndex(sources, options);
  writeFileSync(join(packDir, "multi-pack-index"), data);
  return data;
}

/**
 * 写入增量 MIDX 链的一层并更新 `multi-pack-index-chain`
 *
 * - 若已有 MIDX（经典或链），仅纳入尚未出现在 base 中的 pack，且跳过 base 已有 OID
 * - 若无 MIDX，将当前目录全部 pack 作为链首层
 *
 * @param packDir - `.git/objects/pack` 目录
 * @returns 新层 MIDX 文件内容与 trailer 校验和（40 hex）
 */
export function writeIncrementalMultiPackIndexFile(
  packDir: string,
  options?: WriteMultiPackIndexOptions,
): { data: Buffer; checksumHex: string } {
  const { pairs } = loadPackPairs(packDir);
  if (pairs.length === 0) {
    throw new PackIndexError(`No pack pairs found in ${packDir}`, { path: packDir });
  }

  const baseMidx = resolveBaseMidxForIncrementalWrite(packDir);
  const excludeHashes = new Set<SHA1>();
  const packsInBase = new Set<string>();

  if (baseMidx) {
    for (const hash of baseMidx.listHashes()) {
      excludeHashes.add(hash);
    }
    for (let i = 0; i < baseMidx.globalPackCount; i++) {
      packsInBase.add(baseMidx.getPackName(i));
    }
  }

  const newSources: MidxPackSource[] = [];
  for (const pair of pairs) {
    const idxName = `pack-${pair.checksum}.idx`;
    if (packsInBase.has(idxName)) {
      continue;
    }
    newSources.push({
      packChecksum: pair.checksum,
      index: pair.index,
    });
  }

  if (newSources.length === 0) {
    throw new PackIndexError("No new packs to add to incremental MIDX", { path: packDir });
  }

  const layerOptions: WriteMultiPackIndexOptions = {
    ...options,
    excludeHashes,
    baseMidxCount: baseMidx ? 1 : 0,
  };

  const data = writeMultiPackIndex(newSources, layerOptions);
  const checksumHex = data.subarray(data.length - 20).toString("hex");

  const chainDir = join(packDir, "multi-pack-index.d");
  mkdirSync(chainDir, { recursive: true });
  writeFileSync(join(chainDir, `multi-pack-index-${checksumHex}.midx`), data);

  const chainPath = join(chainDir, "multi-pack-index-chain");
  if (!existsSync(chainPath)) {
    writeFileSync(chainPath, `${checksumHex}\n`);
  } else {
    const text = readFileSync(chainPath, "utf8");
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (!lines.includes(checksumHex)) {
      appendFileSync(chainPath, `${checksumHex}\n`);
    }
  }

  return { data, checksumHex };
}

function resolveBaseMidxForIncrementalWrite(packDir: string) {
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
