/**
 * 增量 Multi-Pack Index 链加载
 *
 * 目录：`objects/pack/multi-pack-index.d/`
 * - `multi-pack-index-chain`：每行一个 40 位十六进制校验和（从旧到新）
 * - `multi-pack-index-$H.midx`：各层 MIDX 文件
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createMidxReaderFromTip, linkMidxLayerToBase, parseMidxLayer } from "./midx-layer.ts";

import type { MidxLayer } from "./midx-layer.ts";
import type { CreateMidxReaderOptions, MidxReader } from "./midx-types.ts";

const CHAIN_FILE = "multi-pack-index-chain";
const HASH_LINE_RE = /^[0-9a-f]{40}$/;

/**
 * 从 pack 目录加载增量 MIDX 链（不含经典 `multi-pack-index`）
 *
 * 链不完整或损坏时返回 null（与 Git 一致：忽略并回退 idx）。
 *
 * @param packDir - `.git/objects/pack` 目录
 * @param options - MIDX 解析选项
 */
export function loadIncrementalMidxChain(
  packDir: string,
  options?: CreateMidxReaderOptions,
): MidxReader | null {
  const tip = tryLoadMidxChainTip(packDir, options);
  if (!tip) {
    return null;
  }
  return createMidxReaderFromTip(tip);
}

/**
 * 解析链文件并得到链顶单层（供测试或扩展使用）
 */
export function tryLoadMidxChainTip(
  packDir: string,
  options?: CreateMidxReaderOptions,
): MidxLayer | null {
  const chainDir = join(packDir, "multi-pack-index.d");
  const chainPath = join(chainDir, CHAIN_FILE);
  if (!existsSync(chainPath)) {
    return null;
  }

  const text = readFileSync(chainPath, "utf8");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return null;
  }

  let chain: MidxLayer | null = null;

  for (const hash of lines) {
    if (!HASH_LINE_RE.test(hash)) {
      return null;
    }

    const midxPath = join(chainDir, `multi-pack-index-${hash}.midx`);
    if (!existsSync(midxPath)) {
      return null;
    }

    try {
      const data = readFileSync(midxPath);
      const layer = parseMidxLayer(data, options);
      linkMidxLayerToBase(layer, chain);
      chain = layer;
    } catch {
      return null;
    }
  }

  return chain;
}
