/**
 * MIDX 二进制数据构建
 *
 * 只根据已加载的 IDX 读取器构建 Buffer，不访问文件系统。
 */

import { createHash } from "node:crypto";

import { PackIndexError } from "../../errors.ts";

import type { SHA1 } from "../../types/index.ts";
import type { PackIndexReader } from "../idx/pack-index.ts";

/** 参与 MIDX 构建的单个 pack 源 */
export interface MidxPackSource {
  /** MIDX PNAM 中的文件名 */
  packIndexFileName?: string;
  /** pack 校验和（40 位十六进制） */
  packChecksum: string;
  /** 对应的 idx 读取器 */
  index: PackIndexReader;
}

/** MIDX 写入选项 */
export interface WriteMultiPackIndexOptions {
  /** MIDX 版本，默认 2 */
  version?: 1 | 2;
  /** 去重时优先保留的 pack 文件名 */
  preferredPackFileName?: string;
  /** 依赖的 base MIDX 文件数 */
  baseMidxCount?: number;
  /** 写入时排除的 OID */
  excludeHashes?: ReadonlySet<SHA1>;
}

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

/**
 * 根据多个 pack 索引写入 MIDX 二进制数据
 *
 * @param packs - pack 源列表（至少一个）
 * @param options - 写入选项
 * @returns 完整的 multi-pack-index 文件内容
 *
 * @example
 * ```ts
 * const data = writeMultiPackIndex([{ packChecksum: checksum, index }]);
 * ```
 */
export function writeMultiPackIndex(
  packs: MidxPackSource[],
  options?: WriteMultiPackIndexOptions,
): Buffer {
  if (packs.length === 0) {
    throw new PackIndexError("writeMultiPackIndex requires at least one pack");
  }

  const version: 1 | 2 = options?.version ?? 2;
  const excludeHashes = options?.excludeHashes;
  const baseMidxCount = options?.baseMidxCount ?? 0;
  const sortedSources = [...packs].sort((a, b) =>
    resolvePackIndexFileName(a).localeCompare(resolvePackIndexFileName(b)),
  );
  const packNameToId = new Map<string, number>();
  for (let index = 0; index < sortedSources.length; index++) {
    packNameToId.set(resolvePackIndexFileName(sortedSources[index]!), index);
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
      const candidate = { hash, packId, offset: idxEntry.offset };
      const existing = rowsByHash.get(hash);
      rowsByHash.set(
        hash,
        existing === undefined
          ? candidate
          : pickDuplicateWinner(existing, candidate, preferredPackId),
      );
    }
  }

  const rows = Array.from(rowsByHash.values()).sort((a, b) => a.hash.localeCompare(b.hash));
  const chunkBodies: { id: string; data: Buffer }[] = [
    { id: CHUNK_PNAM, data: buildPnamChunk(sortedSources.map(resolvePackIndexFileName)) },
    { id: CHUNK_OIDF, data: buildOidfChunk(rows) },
    { id: CHUNK_OIDL, data: buildOidLChunk(rows) },
  ];
  const { ooffChunk, loffChunk } = buildOffsetChunks(rows);
  chunkBodies.push({ id: CHUNK_OOFF, data: ooffChunk });
  if (loffChunk.length > 0) {
    chunkBodies.push({ id: CHUNK_LOFF, data: loffChunk });
  }

  const firstChunkOffset = MIDX_HEADER_SIZE + (chunkBodies.length + 1) * 12;
  const header = Buffer.alloc(MIDX_HEADER_SIZE);
  MIDX_SIGNATURE.copy(header, 0);
  header.writeUInt8(version, 4);
  header.writeUInt8(OID_VERSION_SHA1, 5);
  header.writeUInt8(chunkBodies.length, 6);
  header.writeUInt8(baseMidxCount, 7);
  header.writeUInt32BE(sortedSources.length, 8);

  const lookup = buildChunkLookupTable(chunkBodies, firstChunkOffset);
  const body = Buffer.concat([header, lookup, ...chunkBodies.map((chunk) => chunk.data)]);
  const checksum = createHash("sha1").update(body).digest();
  return Buffer.concat([body, checksum]);
}

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

function buildPnamChunk(packNames: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const name of packNames) {
    parts.push(Buffer.from(name, "ascii"), Buffer.from([0]));
  }
  const raw = Buffer.concat(parts);
  const padding = (4 - (raw.length % 4)) % 4;
  return padding === 0 ? raw : Buffer.concat([raw, Buffer.alloc(padding)]);
}

function buildOidfChunk(rows: MidxObjectRow[]): Buffer {
  const fanout = Buffer.alloc(256 * 4);
  let count = 0;
  for (let index = 0; index < 256; index++) {
    while (count < rows.length && parseInt(rows[count]!.hash.slice(0, 2), 16) <= index) {
      count++;
    }
    fanout.writeUInt32BE(count, index * 4);
  }
  return fanout;
}

function buildOidLChunk(rows: MidxObjectRow[]): Buffer {
  const table = Buffer.alloc(rows.length * SHA1_OID_LEN);
  for (let index = 0; index < rows.length; index++) {
    Buffer.from(rows[index]!.hash, "hex").copy(table, index * SHA1_OID_LEN);
  }
  return table;
}

function buildOffsetChunks(rows: MidxObjectRow[]): { ooffChunk: Buffer; loffChunk: Buffer } {
  const ooffChunk = Buffer.alloc(rows.length * 8);
  const largeOffsets: number[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    let offset = row.offset;
    if (offset >= 0x80000000) {
      const largeIndex = largeOffsets.length;
      largeOffsets.push(offset);
      offset = 0x80000000 | largeIndex;
    }
    const entryOffset = index * 8;
    ooffChunk.writeUInt32BE(row.packId, entryOffset);
    ooffChunk.writeUInt32BE(offset, entryOffset + 4);
  }
  const loffChunk = Buffer.alloc(largeOffsets.length * 8);
  for (let index = 0; index < largeOffsets.length; index++) {
    loffChunk.writeBigUInt64BE(BigInt(largeOffsets[index]!), index * 8);
  }
  return { ooffChunk, loffChunk };
}

function buildChunkLookupTable(
  chunks: { id: string; data: Buffer }[],
  firstChunkOffset: number,
): Buffer {
  const lookup = Buffer.alloc((chunks.length + 1) * 12);
  let offset = firstChunkOffset;
  for (let index = 0; index < chunks.length; index++) {
    const entryOffset = index * 12;
    lookup.write(chunks[index]!.id, entryOffset, 4, "ascii");
    lookup.writeBigUInt64BE(BigInt(offset), entryOffset + 4);
    offset += chunks[index]!.data.length;
  }
  const terminatorOffset = chunks.length * 12;
  lookup.writeUInt32BE(0, terminatorOffset);
  lookup.writeBigUInt64BE(BigInt(offset), terminatorOffset + 4);
  return lookup;
}
