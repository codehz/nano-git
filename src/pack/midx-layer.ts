/**
 * MIDX 单层解析与链式组合
 *
 * 供经典单文件与增量 `multi-pack-index.d/` 链共用。
 */

import { PackIndexError } from "../errors.ts";
import { sha1 } from "../types/index.ts";
import { parseChunkLookup } from "./chunk-lookup.ts";

import type { SHA1 } from "../types/index.ts";
import type {
  CreateMidxReaderOptions,
  MidxBitmappedPack,
  MidxEntry,
  MidxHeader,
  MidxReader,
} from "./midx-types.ts";

// ============================================================================
// 常量
// ============================================================================

const MIDX_SIGNATURE = Buffer.from("MIDX");
const MIDX_HEADER_SIZE = 12;
const SHA1_OID_LEN = 20;
const SHA256_OID_LEN = 32;

const CHUNK_PNAM = "PNAM";
const CHUNK_OIDF = "OIDF";
const CHUNK_OIDL = "OIDL";
const CHUNK_OOFF = "OOFF";
const CHUNK_LOFF = "LOFF";
const CHUNK_BTMP = "BTMP";
const CHUNK_RIDX = "RIDX";

const OOFF_ENTRY_SIZE = 8;
const BTMP_ENTRY_SIZE = 8;

// ============================================================================
// 单层结构
// ============================================================================

/**
 * 已解析的 MIDX 单层（可链接为增量链）
 */
export interface MidxLayer {
  /** 更旧的链层 */
  base: MidxLayer | null;
  /** 基座层中的 pack 总数（全局 pack-int-id 偏移） */
  numPacksInBase: number;
  /** 基座层中的对象总数（全局 OID 序偏移） */
  numObjectsInBase: number;
  readonly header: MidxHeader;
  readonly layerObjectCount: number;
  readonly layerPackCount: number;
  readonly fileChecksumHex: string | undefined;
  lookupInLayer(hash: SHA1): { localPackId: number; offset: number } | undefined;
  getHashAtLayerIndex(index: number): string;
  getEntryAtLayerIndex(index: number): MidxEntry;
  getLocalPackName(localPackId: number): string;
  getBitmappedPackLocal(localPackId: number): MidxBitmappedPack | undefined;
  readonly revindexLocal: readonly number[] | undefined;
}

// ============================================================================
// 解析
// ============================================================================

/**
 * 解析一块 MIDX 文件为单层结构（不链接 base）
 *
 * @param data - 完整 MIDX 文件内容
 * @param options - 构造选项
 */
export function parseMidxLayer(data: Buffer, options?: CreateMidxReaderOptions): MidxLayer {
  if (data.length < MIDX_HEADER_SIZE) {
    throw new PackIndexError("MIDX file too small");
  }

  const signature = data.subarray(0, 4);
  if (!signature.equals(MIDX_SIGNATURE)) {
    throw new PackIndexError(`Invalid MIDX signature: ${signature.toString("hex")}`);
  }

  const version = data.readUInt8(4);
  if (version !== 1 && version !== 2) {
    throw new PackIndexError(`Unsupported MIDX version: ${version}`);
  }

  const oidVersion = data.readUInt8(5);
  if (oidVersion !== 1 && oidVersion !== 2) {
    throw new PackIndexError(`Unsupported MIDX OID version: ${oidVersion}`);
  }

  const expectedOidVersion = options?.expectedOidVersion ?? 1;
  if (oidVersion !== expectedOidVersion) {
    throw new PackIndexError(
      `MIDX OID version ${oidVersion} does not match expected ${expectedOidVersion}`,
    );
  }

  const chunkCount = data.readUInt8(6);
  const baseMidxCount = data.readUInt8(7);
  const packCount = data.readUInt32BE(8);

  const header: MidxHeader = {
    version,
    oidVersion,
    chunkCount,
    baseMidxCount,
    packCount,
  };

  const chunks = parseChunkLookup(data, MIDX_HEADER_SIZE, chunkCount);

  const pnamOffset = chunks.get(CHUNK_PNAM);
  const oidfOffset = chunks.get(CHUNK_OIDF);
  const oidlOffset = chunks.get(CHUNK_OIDL);
  const ooffOffset = chunks.get(CHUNK_OOFF);
  const loffOffset = chunks.get(CHUNK_LOFF);
  const btmpOffset = chunks.get(CHUNK_BTMP);
  const ridxOffset = chunks.get(CHUNK_RIDX);

  if (
    pnamOffset === undefined ||
    oidfOffset === undefined ||
    oidlOffset === undefined ||
    ooffOffset === undefined
  ) {
    throw new PackIndexError("Missing required MIDX chunk");
  }

  const oidLen = oidVersion === 1 ? SHA1_OID_LEN : SHA256_OID_LEN;
  const packNames = parsePackNames(data, pnamOffset, packCount);
  const fanout = parseFanout(data, oidfOffset);
  const layerObjectCount = fanout[255]!;
  const oidTableOffset = oidlOffset;

  const largeOffsets: bigint[] | undefined =
    loffOffset !== undefined ? parseLargeOffsets(data, loffOffset) : undefined;

  const bitmappedPacks = parseBitmappedPacks(data, btmpOffset, packCount);
  const revindexLocal = parseRevindex(data, ridxOffset, layerObjectCount);

  const hashLen = oidLen;
  let fileChecksumHex: string | undefined;
  if (data.length >= hashLen) {
    fileChecksumHex = data.subarray(data.length - hashLen, data.length).toString("hex");
  }

  function getHashAtLayerIndex(index: number): string {
    const offset = oidTableOffset + index * oidLen;
    return data.subarray(offset, offset + oidLen).toString("hex");
  }

  function readOffsetAt(index: number): { localPackId: number; offset: number } {
    const ooffEntryOffset = ooffOffset! + index * OOFF_ENTRY_SIZE;
    const localPackId = data.readUInt32BE(ooffEntryOffset);
    let offset = data.readUInt32BE(ooffEntryOffset + 4);

    if (offset & 0x80000000) {
      if (largeOffsets === undefined) {
        throw new PackIndexError("Large offset flag set but LOFF chunk missing");
      }
      const largeIndex = offset & 0x7fffffff;
      const largeOffset = largeOffsets[largeIndex];
      if (largeOffset === undefined) {
        throw new PackIndexError(`Large offset index out of bounds: ${largeIndex}`);
      }
      offset = Number(largeOffset);
    }

    return { localPackId, offset };
  }

  function lookupInLayer(hash: SHA1): { localPackId: number; offset: number } | undefined {
    const firstByte = parseInt(hash.slice(0, 2), 16);
    const start = firstByte > 0 ? fanout[firstByte - 1]! : 0;
    const end = fanout[firstByte]!;

    let low = start;
    let high = end;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const midHash = getHashAtLayerIndex(mid);
      const cmp = midHash.localeCompare(hash);

      if (cmp < 0) {
        low = mid + 1;
      } else if (cmp > 0) {
        high = mid;
      } else {
        return readOffsetAt(mid);
      }
    }

    return undefined;
  }

  function getEntryAtLayerIndex(index: number): MidxEntry {
    const { localPackId, offset } = readOffsetAt(index);
    return {
      hash: sha1(getHashAtLayerIndex(index)),
      packId: localPackId,
      offset,
    };
  }

  function getLocalPackName(localPackId: number): string {
    if (localPackId < 0 || localPackId >= packNames.length) {
      throw new PackIndexError(`Invalid pack-int-id: ${localPackId}`);
    }
    return packNames[localPackId]!;
  }

  function getBitmappedPackLocal(localPackId: number): MidxBitmappedPack | undefined {
    return bitmappedPacks[localPackId];
  }

  const layer: MidxLayer = {
    base: null,
    numPacksInBase: 0,
    numObjectsInBase: 0,
    header,
    layerObjectCount,
    layerPackCount: packCount,
    fileChecksumHex,
    lookupInLayer,
    getHashAtLayerIndex,
    getEntryAtLayerIndex,
    getLocalPackName,
    getBitmappedPackLocal,
    revindexLocal,
  };

  return layer;
}

/**
 * 将新层链接到已有链（更旧层为 base）
 */
export function linkMidxLayerToBase(layer: MidxLayer, base: MidxLayer | null): void {
  layer.base = base;
  if (base) {
    layer.numPacksInBase = base.numPacksInBase + base.layerPackCount;
    layer.numObjectsInBase = base.numObjectsInBase + base.layerObjectCount;
  } else {
    layer.numPacksInBase = 0;
    layer.numObjectsInBase = 0;
  }
}

// ============================================================================
// 链式 MidxReader
// ============================================================================

/**
 * 由链顶单层构建完整 MIDX 读取器（单文件时 tip 仅一层）
 *
 * @param tip - 链顶（最新）层
 */
export function createMidxReaderFromTip(tip: MidxLayer): MidxReader {
  const globalObjectCount = tip.numObjectsInBase + tip.layerObjectCount;
  const globalPackCount = tip.numPacksInBase + tip.layerPackCount;

  const header: MidxHeader = {
    version: tip.header.version,
    oidVersion: tip.header.oidVersion,
    chunkCount: tip.header.chunkCount,
    baseMidxCount: tip.header.baseMidxCount,
    packCount: globalPackCount,
  };

  function resolveLayerForPack(globalPackId: number): {
    layer: MidxLayer;
    localPackId: number;
  } {
    let layer: MidxLayer | null = tip;
    let id = globalPackId;

    while (layer && id < layer.numPacksInBase) {
      layer = layer.base;
    }

    if (!layer) {
      throw new PackIndexError(`Invalid global pack-int-id: ${globalPackId}`);
    }

    if (id >= layer.numPacksInBase + layer.layerPackCount) {
      throw new PackIndexError(`Invalid global pack-int-id: ${globalPackId}`);
    }

    return { layer, localPackId: id - layer.numPacksInBase };
  }

  function resolveLayerForObjectPosition(globalPos: number): {
    layer: MidxLayer;
    localIndex: number;
  } {
    let layer: MidxLayer | null = tip;
    let pos = globalPos;

    while (layer && pos < layer.numObjectsInBase) {
      layer = layer.base;
    }

    if (!layer) {
      throw new PackIndexError(`Invalid global MIDX object position: ${globalPos}`);
    }

    if (pos >= layer.numObjectsInBase + layer.layerObjectCount) {
      throw new PackIndexError(`Invalid global MIDX object position: ${globalPos}`);
    }

    return { layer, localIndex: pos - layer.numObjectsInBase };
  }

  function lookup(hash: SHA1): MidxEntry | undefined {
    let layer: MidxLayer | null = tip;
    while (layer) {
      const hit = layer.lookupInLayer(hash);
      if (hit) {
        return {
          hash,
          packId: layer.numPacksInBase + hit.localPackId,
          offset: hit.offset,
        };
      }
      layer = layer.base;
    }
    return undefined;
  }

  function has(hash: SHA1): boolean {
    return lookup(hash) !== undefined;
  }

  function listHashes(): SHA1[] {
    const hashes: SHA1[] = [];
    for (let i = 0; i < globalObjectCount; i++) {
      const { layer, localIndex } = resolveLayerForObjectPosition(i);
      hashes.push(sha1(layer.getHashAtLayerIndex(localIndex)));
    }
    return hashes;
  }

  function getPackName(packId: number): string {
    const { layer, localPackId } = resolveLayerForPack(packId);
    return layer.getLocalPackName(localPackId);
  }

  function getBitmappedPack(globalPackId: number): MidxBitmappedPack | undefined {
    const { layer, localPackId } = resolveLayerForPack(globalPackId);
    return layer.getBitmappedPackLocal(localPackId);
  }

  function listBitmappedGlobalPackIds(): number[] {
    const ids: number[] = [];
    let layer: MidxLayer | null = tip;
    while (layer) {
      for (let local = 0; local < layer.layerPackCount; local++) {
        if (layer.getBitmappedPackLocal(local)) {
          ids.push(layer.numPacksInBase + local);
        }
      }
      layer = layer.base;
    }
    return ids;
  }

  /**
   * RIDX：pseudo-pack 下标 → 全局 MIDX OID 序下标（与 gitformat-pack 一致）。
   *
   * 增量链由链顶 MIDX 的 RIDX 覆盖整条拼接 pseudo 序时，长度等于 `objectCount`。
   */
  function getRevindexPseudoPackOrder(): readonly number[] | undefined {
    return tip.revindexLocal;
  }

  return {
    header,
    get objectCount(): number {
      return globalObjectCount;
    },
    get globalPackCount(): number {
      return globalPackCount;
    },
    lookup,
    has,
    listHashes,
    getPackName,
    getBitmappedPack,
    listBitmappedGlobalPackIds,
    getRevindexPseudoPackOrder,
    get tipChecksumHex(): string | undefined {
      return tip.fileChecksumHex;
    },
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

function parsePackNames(data: Buffer, offset: number, packCount: number): string[] {
  const names: string[] = [];
  let cursor = offset;

  for (let i = 0; i < packCount; i++) {
    let end = cursor;
    while (end < data.length && data[end] !== 0) {
      end++;
    }

    if (end >= data.length) {
      throw new PackIndexError("PNAM chunk truncated");
    }

    const name = data.subarray(cursor, end).toString("ascii");
    names.push(name);
    cursor = end + 1;
  }

  return names;
}

function parseFanout(data: Buffer, offset: number): number[] {
  const fanout: number[] = [];
  for (let i = 0; i < 256; i++) {
    fanout.push(data.readUInt32BE(offset + i * 4));
  }
  return fanout;
}

function parseLargeOffsets(data: Buffer, offset: number): bigint[] {
  const oidLen = data.readUInt8(5) === 1 ? SHA1_OID_LEN : SHA256_OID_LEN;
  const trailerStart = data.length - oidLen;

  if (trailerStart < offset) {
    throw new PackIndexError("LOFF chunk truncated or trailer missing");
  }

  const loffSize = trailerStart - offset;
  if (loffSize % 8 !== 0) {
    throw new PackIndexError("LOFF chunk size not aligned to 8 bytes");
  }

  const count = loffSize / 8;
  const offsets: bigint[] = [];
  for (let i = 0; i < count; i++) {
    offsets.push(data.readBigUInt64BE(offset + i * 8));
  }

  return offsets;
}

function parseBitmappedPacks(
  data: Buffer,
  offset: number | undefined,
  packCount: number,
): Array<MidxBitmappedPack | undefined> {
  const result: Array<MidxBitmappedPack | undefined> = Array.from({ length: packCount });
  if (offset === undefined) {
    return result;
  }

  for (let i = 0; i < packCount; i++) {
    const entryOffset = offset + i * BTMP_ENTRY_SIZE;
    if (entryOffset + BTMP_ENTRY_SIZE > data.length) {
      break;
    }
    const bitmapPos = data.readUInt32BE(entryOffset);
    const bitmapNr = data.readUInt32BE(entryOffset + 4);
    if (bitmapNr === 0) {
      result[i] = undefined;
    } else {
      result[i] = { bitmapPos, bitmapNr };
    }
  }

  return result;
}

function parseRevindex(
  data: Buffer,
  offset: number | undefined,
  objectCount: number,
): readonly number[] | undefined {
  if (offset === undefined || objectCount === 0) {
    return undefined;
  }

  const values: number[] = [];
  for (let i = 0; i < objectCount; i++) {
    const pos = offset + i * 4;
    if (pos + 4 > data.length) {
      throw new PackIndexError("RIDX chunk truncated");
    }
    values.push(data.readUInt32BE(pos));
  }
  return values;
}
