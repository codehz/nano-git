/**
 * Multi-Pack Index (MIDX) 只读读取器
 *
 * 支持 Git MIDX v1/v2 经典单文件格式，SHA-1 仓库。
 *
 * 格式参考：
 * - https://git-scm.com/docs/gitformat-pack#_multi_pack_index_midx_files_have_the_following_format
 *
 * @example
 * ```ts
 * const data = readFileSync("/path/to/multi-pack-index");
 * const midx = createMidxReader(data);
 * const entry = midx.lookup(hash);
 * if (entry) {
 *   console.log(entry.packId, entry.offset);
 * }
 * ```
 */

import { PackIndexError } from "../core/errors.ts";
import { sha1 } from "../core/types.ts";
import { parseChunkLookup } from "./chunk-lookup.ts";

import type { SHA1 } from "../core/types.ts";
import type { MidxEntry, MidxHeader, MidxReader } from "./midx-types.ts";

// ============================================================================
// 常量
// ============================================================================

/** MIDX 文件签名 */
const MIDX_SIGNATURE = Buffer.from("MIDX");

/** MIDX 头部长度 */
const MIDX_HEADER_SIZE = 12;

/** SHA-1 OID 长度 */
const SHA1_OID_LEN = 20;

/** SHA-256 OID 长度 */
const SHA256_OID_LEN = 32;

/** chunk id */
const CHUNK_PNAM = "PNAM";
const CHUNK_OIDF = "OIDF";
const CHUNK_OIDL = "OIDL";
const CHUNK_OOFF = "OOFF";
const CHUNK_LOFF = "LOFF";

// ============================================================================
// 解析
// ============================================================================

/**
 * 创建 MIDX 读取器
 *
 * @param data - 完整的 `multi-pack-index` 文件数据
 * @returns MIDX 读取器实例
 *
 * @example
 * ```ts
 * const midx = createMidxReader(data);
 * console.log(midx.objectCount);
 * ```
 */
export function createMidxReader(data: Buffer): MidxReader {
  // === 解析头部 ===

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

  // === 解析 chunk lookup 表 ===

  const chunks = parseChunkLookup(data, MIDX_HEADER_SIZE, chunkCount);

  const pnamOffset = chunks.get(CHUNK_PNAM);
  const oidfOffset = chunks.get(CHUNK_OIDF);
  const oidlOffset = chunks.get(CHUNK_OIDL);
  const ooffOffset = chunks.get(CHUNK_OOFF);
  const loffOffset = chunks.get(CHUNK_LOFF);

  if (
    pnamOffset === undefined ||
    oidfOffset === undefined ||
    oidlOffset === undefined ||
    ooffOffset === undefined
  ) {
    throw new PackIndexError("Missing required MIDX chunk");
  }

  // === 解析 OID 长度 ===

  const oidLen = oidVersion === 1 ? SHA1_OID_LEN : SHA256_OID_LEN;

  // === 解析 PNAM ===

  const packNames = parsePackNames(data, pnamOffset, packCount);

  // === 解析 OIDF ===

  const fanout = parseFanout(data, oidfOffset);
  const objectCount = fanout[255]!;

  // === 解析 OIDL ===

  const oidTableOffset = oidlOffset;

  // === 解析 OOFF ===

  const ooffEntrySize = 8;

  // === 解析 LOFF（可选）===

  const largeOffsets: bigint[] | undefined =
    loffOffset !== undefined ? parseLargeOffsets(data, loffOffset) : undefined;

  // === 内部函数 ===

  /**
   * 获取指定索引位置的哈希字符串
   */
  function getHashAt(index: number): string {
    const offset = oidTableOffset + index * oidLen;
    return data.subarray(offset, offset + oidLen).toString("hex");
  }

  /**
   * 获取指定索引位置的条目
   */
  function getEntryAt(index: number): MidxEntry {
    const hash = sha1(getHashAt(index));

    if (ooffOffset === undefined) {
      throw new PackIndexError("Missing OOFF chunk");
    }

    const ooffEntryOffset = ooffOffset + index * ooffEntrySize;
    const packId = data.readUInt32BE(ooffEntryOffset);
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

    return { hash, packId, offset };
  }

  // === 公共方法 ===

  function lookup(hash: SHA1): MidxEntry | undefined {
    const firstByte = parseInt(hash.slice(0, 2), 16);
    const start = firstByte > 0 ? fanout[firstByte - 1]! : 0;
    const end = fanout[firstByte]!;

    let low = start;
    let high = end;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const midHash = getHashAt(mid);
      const cmp = midHash.localeCompare(hash);

      if (cmp < 0) {
        low = mid + 1;
      } else if (cmp > 0) {
        high = mid;
      } else {
        return getEntryAt(mid);
      }
    }

    return undefined;
  }

  function has(hash: SHA1): boolean {
    return lookup(hash) !== undefined;
  }

  function listHashes(): SHA1[] {
    const hashes: SHA1[] = [];
    for (let i = 0; i < objectCount; i++) {
      hashes.push(sha1(getHashAt(i)));
    }
    return hashes;
  }

  function getPackName(packId: number): string {
    if (packId < 0 || packId >= packNames.length) {
      throw new PackIndexError(`Invalid pack-int-id: ${packId}`);
    }
    return packNames[packId]!;
  }

  return {
    header,
    get objectCount(): number {
      return objectCount;
    },
    lookup,
    has,
    listHashes,
    getPackName,
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 解析 PNAM chunk：NUL 结尾的 pack 文件名列表
 */
function parsePackNames(data: Buffer, offset: number, packCount: number): string[] {
  const names: string[] = [];
  let cursor = offset;

  for (let i = 0; i < packCount; i++) {
    // 查找下一个 NUL
    let end = cursor;
    while (end < data.length && data[end] !== 0) {
      end++;
    }

    if (end >= data.length) {
      throw new PackIndexError("PNAM chunk truncated");
    }

    const name = data.subarray(cursor, end).toString("ascii");
    names.push(name);
    cursor = end + 1; // 跳过 NUL
  }

  return names;
}

/**
 * 解析 OIDF fanout 表
 */
function parseFanout(data: Buffer, offset: number): number[] {
  const fanout: number[] = [];
  for (let i = 0; i < 256; i++) {
    fanout.push(data.readUInt32BE(offset + i * 4));
  }
  return fanout;
}

/**
 * 解析 LOFF chunk 中的大偏移列表
 *
 * LOFF chunk 没有显式长度字段，其结束位置由文件 trailer 决定。
 * 在经典 MIDX 中，LOFF 之后就是文件 trailer（hash 校验和）。
 * 这里用文件末尾减去 trailer 长度来推断 LOFF 结束位置。
 */
function parseLargeOffsets(data: Buffer, offset: number): bigint[] {
  // MIDX trailer 长度等于 OID 长度（SHA-1 为 20 字节，SHA-256 为 32 字节）
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
