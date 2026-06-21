/**
 * Packfile 索引读取
 */

import { PackIndexError } from "../../core/errors.ts";
import { sha1 } from "../../core/types.ts";
import {
  IDX_V2_FANOUT_SIZE,
  IDX_V2_HEADER_SIZE,
  IDX_V2_SIGNATURE,
  IDX_V2_VERSION,
} from "./constants.ts";

import type { SHA1 } from "../../core/types.ts";
import type { PackIndexEntry } from "./pack-index-types.ts";

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
  return new PackIndexReader(data);
}

/**
 * Packfile 索引读取器类
 */
export class PackIndexReader {
  private readonly data: Buffer;
  private readonly _objectCount: number;
  private readonly fanout: number[];
  private readonly sha1TableOffset: number;
  private readonly crc32TableOffset: number;
  private readonly offsetTableOffset: number;
  private readonly largeOffsetTable: number;

  constructor(data: Buffer) {
    this.data = data;
    this.fanout = [];

    this.parseHeader();
    this.parseFanout();
    this._objectCount = this.fanout[255]!;

    this.sha1TableOffset = IDX_V2_HEADER_SIZE + IDX_V2_FANOUT_SIZE;
    this.crc32TableOffset = this.sha1TableOffset + this._objectCount * 20;
    this.offsetTableOffset = this.crc32TableOffset + this._objectCount * 4;
    this.largeOffsetTable = this.offsetTableOffset + this._objectCount * 4;
  }

  /** 对象数量 */
  get objectCount(): number {
    return this._objectCount;
  }

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
  lookup(hash: SHA1): PackIndexEntry | undefined {
    const firstByte = parseInt(hash.slice(0, 2), 16);
    const start = firstByte > 0 ? this.fanout[firstByte - 1]! : 0;
    const end = this.fanout[firstByte]!;

    let low = start;
    let high = end;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const midHash = this.getHashAt(mid);
      const cmp = midHash.localeCompare(hash);

      if (cmp < 0) {
        low = mid + 1;
      } else if (cmp > 0) {
        high = mid;
      } else {
        return this.getEntryAt(mid);
      }
    }

    return undefined;
  }

  /**
   * 检查对象是否存在
   *
   * @example
   * ```ts
   * const exists = index.has(hash);
   * ```
   */
  has(hash: SHA1): boolean {
    return this.lookup(hash) !== undefined;
  }

  /**
   * 获取所有对象的哈希列表
   *
   * @example
   * ```ts
   * const hashes = index.listHashes();
   * ```
   */
  listHashes(): SHA1[] {
    const hashes: SHA1[] = [];
    for (let i = 0; i < this._objectCount; i++) {
      hashes.push(sha1(this.getHashAt(i)));
    }
    return hashes;
  }

  /**
   * 解析头部
   */
  private parseHeader(): void {
    if (this.data.length < IDX_V2_HEADER_SIZE) {
      throw new PackIndexError("Index file too small");
    }

    const signature = this.data.subarray(0, 4);
    if (!signature.equals(IDX_V2_SIGNATURE)) {
      throw new PackIndexError(`Invalid signature: ${signature.toString("hex")}`);
    }

    const version = this.data.readUInt32BE(4);
    if (version !== IDX_V2_VERSION) {
      throw new PackIndexError(`Unsupported version: ${version}`);
    }
  }

  /**
   * 解析扇出表
   */
  private parseFanout(): void {
    const fanoutStart = IDX_V2_HEADER_SIZE;
    for (let i = 0; i < 256; i++) {
      this.fanout.push(this.data.readUInt32BE(fanoutStart + i * 4));
    }
  }

  /**
   * 获取指定索引位置的哈希
   */
  private getHashAt(index: number): string {
    const offset = this.sha1TableOffset + index * 20;
    return this.data.subarray(offset, offset + 20).toString("hex");
  }

  /**
   * 获取指定索引位置的条目
   */
  private getEntryAt(index: number): PackIndexEntry {
    const hash = sha1(this.getHashAt(index));
    const crc32 = this.data.readUInt32BE(this.crc32TableOffset + index * 4);

    let offset = this.data.readUInt32BE(this.offsetTableOffset + index * 4);
    if (offset & 0x80000000) {
      const largeIndex = offset & 0x7fffffff;
      offset = Number(this.data.readBigUInt64BE(this.largeOffsetTable + largeIndex * 8));
    }

    return { hash, offset, crc32 };
  }
}
