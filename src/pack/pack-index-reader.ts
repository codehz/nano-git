/**
 * Packfile 索引读取
 */

import { PackIndexError } from "../core/errors.ts";
import { sha1 } from "../core/types.ts";
import {
  IDX_V2_FANOUT_SIZE,
  IDX_V2_HEADER_SIZE,
  IDX_V2_SIGNATURE,
  IDX_V2_VERSION,
} from "./constants.ts";

import type { SHA1 } from "../core/types.ts";
import type { PackIndexEntry } from "./pack-index-types.ts";

// ============================================================================
// 接口
// ============================================================================

/**
 * Packfile 索引读取器接口
 */
export interface PackIndexReader {
  /** 对象数量 */
  readonly objectCount: number;

  /**
   * 查找对象的索引条目
   *
   * @param hash - 对象的 SHA-1 哈希
   * @returns 索引条目，如果不存在则返回 undefined
   *
   * @example
   * ```ts
   * const entry = index.lookup(hash);
   * console.log(entry?.offset);
   * ```
   */
  lookup(hash: SHA1): PackIndexEntry | undefined;

  /**
   * 检查对象是否存在
   *
   * @example
   * ```ts
   * const exists = index.has(hash);
   * ```
   */
  has(hash: SHA1): boolean;

  /**
   * 获取所有对象的哈希列表
   *
   * @example
   * ```ts
   * const hashes = index.listHashes();
   * ```
   */
  listHashes(): SHA1[];
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Packfile 索引读取器
 *
 * @param data - 完整的 .idx 文件数据
 * @returns 索引读取器实例
 *
 * @example
 * ```ts
 * const index = createPackIndexReader(idxData);
 * console.log(index.objectCount);
 * ```
 */
export function createPackIndexReader(data: Buffer): PackIndexReader {
  // === 解析头部 ===

  if (data.length < IDX_V2_HEADER_SIZE) {
    throw new PackIndexError("Index file too small");
  }

  const signature = data.subarray(0, 4);
  if (!signature.equals(IDX_V2_SIGNATURE)) {
    throw new PackIndexError(`Invalid signature: ${signature.toString("hex")}`);
  }

  const version = data.readUInt32BE(4);
  if (version !== IDX_V2_VERSION) {
    throw new PackIndexError(`Unsupported version: ${version}`);
  }

  // === 解析扇出表 ===

  const fanout: number[] = [];
  const fanoutStart = IDX_V2_HEADER_SIZE;
  for (let i = 0; i < 256; i++) {
    fanout.push(data.readUInt32BE(fanoutStart + i * 4));
  }

  const _objectCount = fanout[255]!;

  // === 计算偏移量 ===

  const sha1TableOffset = IDX_V2_HEADER_SIZE + IDX_V2_FANOUT_SIZE;
  const crc32TableOffset = sha1TableOffset + _objectCount * 20;
  const offsetTableOffset = crc32TableOffset + _objectCount * 4;
  const largeOffsetTable = offsetTableOffset + _objectCount * 4;

  // === 内部函数 ===

  /**
   * 获取指定索引位置的哈希
   */
  function getHashAt(index: number): string {
    const offset = sha1TableOffset + index * 20;
    return data.subarray(offset, offset + 20).toString("hex");
  }

  /**
   * 获取指定索引位置的条目
   */
  function getEntryAt(index: number): PackIndexEntry {
    const hash = sha1(getHashAt(index));
    const crc32 = data.readUInt32BE(crc32TableOffset + index * 4);

    let offset = data.readUInt32BE(offsetTableOffset + index * 4);
    if (offset & 0x80000000) {
      const largeIndex = offset & 0x7fffffff;
      offset = Number(data.readBigUInt64BE(largeOffsetTable + largeIndex * 8));
    }

    return { hash, offset, crc32 };
  }

  // === 公共方法 ===

  function lookup(hash: SHA1): PackIndexEntry | undefined {
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
    for (let i = 0; i < _objectCount; i++) {
      hashes.push(sha1(getHashAt(i)));
    }
    return hashes;
  }

  return {
    get objectCount(): number {
      return _objectCount;
    },
    lookup,
    has,
    listHashes,
  };
}
