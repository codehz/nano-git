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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { loadIncrementalMidxChain } from "./midx-chain.ts";
import { createMidxReader } from "./midx-reader.ts";
import { loadPackPairs } from "./pack-store-loader.ts";

import type { SHA1 } from "../types/index.ts";
import type { PackIndexReader } from "./pack-index.ts";

// ============================================================================
// 类型
// ============================================================================

/**
 * 参与 MIDX 构建的单个 pack 源
 */
export interface MidxPackSource {
  /**
   * MIDX `PNAM` 中的文件名（Git 写入 `pack-<40 hex>.idx`）。
   * 若省略，由 `packChecksum` 推导。
   */
  packIndexFileName?: string;
  /** pack 校验和（40 位十六进制），用于默认 PNAM 名 */
  packChecksum: string;
  /** 对应的 idx 读取器 */
  index: PackIndexReader;
}

/**
 * MIDX 写入选项
 */
export interface WriteMultiPackIndexOptions {
  /** MIDX 版本，默认 2（与 Git `midx.version` 默认一致） */
  version?: 1 | 2;
  /**
   * 去重时优先保留的 pack 文件名。
   * 未指定时，同一 OID 保留 pack-int-id 较大者（PNAM 中靠后）。
   */
  preferredPackFileName?: string;
  /** 依赖的 base multi-pack-index 文件数（增量层通常为 1，链首层为 0） */
  baseMidxCount?: number;
  /** 写入时排除的 OID（已在 base MIDX 中） */
  excludeHashes?: ReadonlySet<SHA1>;
}

// ============================================================================
// 常量
// ============================================================================

const MIDX_SIGNATURE = Buffer.from("MIDX");
const MIDX_HEADER_SIZE = 12;
const SHA1_OID_LEN = 20;
const OID_VERSION_SHA1 = 1;

const CHUNK_PNAM = "PNAM";
const CHUNK_OIDF = "OIDF";
const CHUNK_OIDL = "OIDL";
const CHUNK_OOFF = "OOFF";
const CHUNK_LOFF = "LOFF";

interface MidxObjectRow {
  hash: SHA1;
  packId: number;
  offset: number;
}

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 根据多个 pack 索引写入 MIDX 二进制数据
 *
 * @param packs - pack 源列表（至少一个）
 * @param options - 写入选项
 * @returns 完整的 `multi-pack-index` 文件内容
 *
 * @example
 * ```ts
 * const midx = writeMultiPackIndex(sources);
 * expect(createMidxReader(midx).objectCount).toBe(42);
 * ```
 */
export function writeMultiPackIndex(
  packs: MidxPackSource[],
  options?: WriteMultiPackIndexOptions,
): Buffer {
  if (packs.length === 0) {
    throw new Error("writeMultiPackIndex requires at least one pack");
  }

  const version: 1 | 2 = options?.version ?? 2;
  const excludeHashes = options?.excludeHashes;
  const baseMidxCount = options?.baseMidxCount ?? 0;

  const sortedSources = [...packs].sort((a, b) =>
    resolvePackIndexFileName(a).localeCompare(resolvePackIndexFileName(b)),
  );

  const packNameToId = new Map<string, number>();
  for (let i = 0; i < sortedSources.length; i++) {
    packNameToId.set(resolvePackIndexFileName(sortedSources[i]!), i);
  }

  const preferredPackFileName = options?.preferredPackFileName;
  const preferredPackId =
    preferredPackFileName !== undefined ? packNameToId.get(preferredPackFileName) : undefined;

  const rowsByHash = new Map<SHA1, MidxObjectRow>();

  for (const source of sortedSources) {
    const packId = packNameToId.get(resolvePackIndexFileName(source))!;
    for (const hash of source.index.listHashes()) {
      if (excludeHashes?.has(hash)) {
        continue;
      }
      const idxEntry = source.index.lookup(hash);
      if (idxEntry === undefined) {
        continue;
      }

      const candidate: MidxObjectRow = {
        hash,
        packId,
        offset: idxEntry.offset,
      };

      const existing = rowsByHash.get(hash);
      if (existing === undefined) {
        rowsByHash.set(hash, candidate);
        continue;
      }

      rowsByHash.set(hash, pickDuplicateWinner(existing, candidate, preferredPackId));
    }
  }

  const rows = Array.from(rowsByHash.values()).sort((a, b) => a.hash.localeCompare(b.hash));

  const pnamChunk = buildPnamChunk(sortedSources.map((s) => resolvePackIndexFileName(s)));
  const oidfChunk = buildOidfChunk(rows);
  const oidlChunk = buildOidLChunk(rows);
  const { ooffChunk, loffChunk } = buildOffsetChunks(rows);

  const chunkBodies: { id: string; data: Buffer }[] = [
    { id: CHUNK_PNAM, data: pnamChunk },
    { id: CHUNK_OIDF, data: oidfChunk },
    { id: CHUNK_OIDL, data: oidlChunk },
    { id: CHUNK_OOFF, data: ooffChunk },
  ];
  if (loffChunk.length > 0) {
    chunkBodies.push({ id: CHUNK_LOFF, data: loffChunk });
  }

  const chunkCount = chunkBodies.length;
  const lookupSize = (chunkCount + 1) * 12;
  const firstChunkOffset = MIDX_HEADER_SIZE + lookupSize;

  const header = Buffer.alloc(MIDX_HEADER_SIZE);
  MIDX_SIGNATURE.copy(header, 0);
  header.writeUInt8(version, 4);
  header.writeUInt8(OID_VERSION_SHA1, 5);
  header.writeUInt8(chunkCount, 6);
  header.writeUInt8(baseMidxCount, 7);
  header.writeUInt32BE(sortedSources.length, 8);

  const lookup = buildChunkLookupTable(chunkBodies, firstChunkOffset);
  const chunkParts = chunkBodies.map((chunk) => chunk.data);

  const body = Buffer.concat([header, lookup, ...chunkParts]);
  const checksum = createHash("sha1").update(body).digest();
  return Buffer.concat([body, checksum]);
}

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
    throw new Error(`No pack pairs found in ${packDir}`);
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
    throw new Error(`No pack pairs found in ${packDir}`);
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
    throw new Error("No new packs to add to incremental MIDX");
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

// ============================================================================
// 去重
// ============================================================================

function resolvePackIndexFileName(source: MidxPackSource): string {
  return source.packIndexFileName ?? `pack-${source.packChecksum}.idx`;
}

function pickDuplicateWinner(
  existing: MidxObjectRow,
  candidate: MidxObjectRow,
  preferredPackId: number | undefined,
): MidxObjectRow {
  if (preferredPackId !== undefined) {
    if (existing.packId === preferredPackId && candidate.packId !== preferredPackId) {
      return existing;
    }
    if (candidate.packId === preferredPackId && existing.packId !== preferredPackId) {
      return candidate;
    }
  }

  return candidate.packId > existing.packId ? candidate : existing;
}

// ============================================================================
// Chunk 构建
// ============================================================================

function buildPnamChunk(packNames: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const name of packNames) {
    parts.push(Buffer.from(name, "ascii"));
    parts.push(Buffer.from([0]));
  }

  const raw = Buffer.concat(parts);
  const padding = (4 - (raw.length % 4)) % 4;
  if (padding === 0) {
    return raw;
  }
  return Buffer.concat([raw, Buffer.alloc(padding)]);
}

function buildOidfChunk(rows: MidxObjectRow[]): Buffer {
  const fanout = Buffer.alloc(256 * 4);
  let count = 0;

  for (let i = 0; i < 256; i++) {
    while (count < rows.length && parseInt(rows[count]!.hash.slice(0, 2), 16) <= i) {
      count++;
    }
    fanout.writeUInt32BE(count, i * 4);
  }

  return fanout;
}

function buildOidLChunk(rows: MidxObjectRow[]): Buffer {
  const table = Buffer.alloc(rows.length * SHA1_OID_LEN);
  for (let i = 0; i < rows.length; i++) {
    Buffer.from(rows[i]!.hash, "hex").copy(table, i * SHA1_OID_LEN);
  }
  return table;
}

function buildOffsetChunks(rows: MidxObjectRow[]): { ooffChunk: Buffer; loffChunk: Buffer } {
  const ooffChunk = Buffer.alloc(rows.length * 8);
  const largeOffsets: number[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    let offset = row.offset;

    if (offset >= 0x80000000) {
      const largeIndex = largeOffsets.length;
      largeOffsets.push(offset);
      offset = 0x80000000 | largeIndex;
    }

    const entryOffset = i * 8;
    ooffChunk.writeUInt32BE(row.packId, entryOffset);
    ooffChunk.writeUInt32BE(offset, entryOffset + 4);
  }

  const loffChunk = Buffer.alloc(largeOffsets.length * 8);
  for (let i = 0; i < largeOffsets.length; i++) {
    loffChunk.writeBigUInt64BE(BigInt(largeOffsets[i]!), i * 8);
  }

  return { ooffChunk, loffChunk };
}

function buildChunkLookupTable(
  chunks: { id: string; data: Buffer }[],
  firstChunkOffset: number,
): Buffer {
  const lookup = Buffer.alloc((chunks.length + 1) * 12);
  let offset = firstChunkOffset;

  for (let i = 0; i < chunks.length; i++) {
    const entryOffset = i * 12;
    lookup.write(chunks[i]!.id, entryOffset, 4, "ascii");
    lookup.writeBigUInt64BE(BigInt(offset), entryOffset + 4);
    offset += chunks[i]!.data.length;
  }

  const terminatorOffset = chunks.length * 12;
  lookup.writeUInt32BE(0, terminatorOffset);
  lookup.writeBigUInt64BE(BigInt(offset), terminatorOffset + 4);

  return lookup;
}
