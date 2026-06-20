/**
 * Packfile 索引（.idx 文件）读写
 *
 * Git 使用索引文件来快速定位 packfile 中的对象。
 * 索引文件 v2 格式：
 * - 头部：4 字节魔数 + 4 字节版本号
 * - 扇出表（fanout table）：256 个 4 字节整数，按 SHA-1 首字节分组
 * - SHA-1 表：所有对象的 SHA-1 哈希（按字典序排列）
 * - CRC32 表：每个对象压缩数据的 CRC32 校验和
 * - 偏移量表：每个对象在 packfile 中的 4 字节偏移量
 * - 大偏移量表（可选）：超过 4GB 的偏移量使用 8 字节存储
 * - Packfile 校验和：20 字节
 * - 索引文件校验和：20 字节
 *
 * @example
 * ```ts
 * const index = createPackIndexReader(idxData);
 * const entry = index.lookup(hash);
 * if (entry) {
 *   console.log(`对象在 packfile 中的偏移量: ${entry.offset}`);
 * }
 * ```
 */

import { createHash } from "node:crypto";
import type { SHA1 } from "../core/types.ts";
import { sha1 } from "../core/types.ts";
import { PackIndexError } from "../core/errors.ts";
import {
  IDX_V2_SIGNATURE,
  IDX_V2_VERSION,
  IDX_V2_HEADER_SIZE,
  IDX_V2_FANOUT_SIZE,
} from "./constants.ts";

// ============================================================================
// 索引条目
// ============================================================================

/** 索引中的对象条目 */
export interface PackIndexEntry {
  /** 对象的 SHA-1 哈希 */
  hash: SHA1;
  /** 对象在 packfile 中的偏移量 */
  offset: number;
  /** 压缩数据的 CRC32 校验和 */
  crc32: number;
}

// ============================================================================
// 索引读取器
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
 * console.log(`索引包含 ${index.objectCount} 个对象`);
 *
 * const entry = index.lookup(hash);
 * if (entry) {
 *   console.log(`偏移量: ${entry.offset}`);
 * }
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

    // 解析头部
    this.parseHeader();

    // 解析扇出表
    this.parseFanout();
    this._objectCount = this.fanout[255]!;

    // 计算各表的偏移量
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
   * 查找对象的索引条目
   *
   * @param hash - 对象的 SHA-1 哈希
   * @returns 索引条目，如果不存在则返回 undefined
   *
   * @example
   * ```ts
   * const entry = index.lookup(hash);
   * if (entry) {
   *   console.log(`偏移量: ${entry.offset}`);
   * }
   * ```
   */
  lookup(hash: SHA1): PackIndexEntry | undefined {
    const firstByte = parseInt(hash.slice(0, 2), 16);

    // 确定搜索范围
    const start = firstByte > 0 ? this.fanout[firstByte - 1]! : 0;
    const end = this.fanout[firstByte]!;

    // 二分查找
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
        // 找到匹配
        return this.getEntryAt(mid);
      }
    }

    return undefined;
  }

  /**
   * 检查对象是否存在
   */
  has(hash: SHA1): boolean {
    return this.lookup(hash) !== undefined;
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

    // 读取 CRC32
    const crc32 = this.data.readUInt32BE(this.crc32TableOffset + index * 4);

    // 读取偏移量
    let offset = this.data.readUInt32BE(this.offsetTableOffset + index * 4);

    // 检查是否是大偏移量（最高位为 1）
    if (offset & 0x80000000) {
      const largeIndex = offset & 0x7fffffff;
      offset = Number(this.data.readBigUInt64BE(this.largeOffsetTable + largeIndex * 8));
    }

    return { hash, offset, crc32 };
  }

  /**
   * 获取所有对象的哈希列表
   */
  listHashes(): SHA1[] {
    const hashes: SHA1[] = [];
    for (let i = 0; i < this._objectCount; i++) {
      hashes.push(sha1(this.getHashAt(i)));
    }
    return hashes;
  }
}

// ============================================================================
// 索引写入器
// ============================================================================

/**
 * 创建 Packfile 索引写入器
 *
 * @returns 索引写入器实例
 *
 * @example
 * ```ts
 * const writer = createPackIndexWriter();
 * writer.addEntry({ hash, offset: 12, crc32: 0x12345678 });
 * const idxData = writer.build(packChecksum);
 * ```
 */
export function createPackIndexWriter(): PackIndexWriter {
  return new PackIndexWriter();
}

/**
 * Packfile 索引写入器类
 */
export class PackIndexWriter {
  private entries: PackIndexEntry[] = [];

  /**
   * 添加一个索引条目
   *
   * @param entry - 索引条目
   *
   * @example
   * ```ts
   * writer.addEntry({
   *   hash: sha1("abc..."),
   *   offset: 12,
   *   crc32: 0x12345678,
   * });
   * ```
   */
  addEntry(entry: PackIndexEntry): void {
    this.entries.push(entry);
  }

  /**
   * 构建索引文件数据
   *
   * @param packChecksum - packfile 的 SHA-1 校验和（20 字节）
   * @returns 完整的 .idx 文件数据
   *
   * @example
   * ```ts
   * const idxData = writer.build(packChecksum);
   * writeFileSync("pack-xxx.idx", idxData);
   * ```
   */
  build(packChecksum: Buffer): Buffer {
    // 按 SHA-1 排序
    const sorted = [...this.entries].sort((a, b) => a.hash.localeCompare(b.hash));

    const parts: Buffer[] = [];

    // 写入头部
    const header = Buffer.alloc(IDX_V2_HEADER_SIZE);
    IDX_V2_SIGNATURE.copy(header, 0);
    header.writeUInt32BE(IDX_V2_VERSION, 4);
    parts.push(header);

    // 构建扇出表
    const fanout = Buffer.alloc(IDX_V2_FANOUT_SIZE);
    let count = 0;
    for (let i = 0; i < 256; i++) {
      while (count < sorted.length && parseInt(sorted[count]!.hash.slice(0, 2), 16) <= i) {
        count++;
      }
      fanout.writeUInt32BE(count, i * 4);
    }
    parts.push(fanout);

    // 写入 SHA-1 表
    const sha1Table = Buffer.alloc(sorted.length * 20);
    for (let i = 0; i < sorted.length; i++) {
      Buffer.from(sorted[i]!.hash, "hex").copy(sha1Table, i * 20);
    }
    parts.push(sha1Table);

    // 写入 CRC32 表
    const crc32Table = Buffer.alloc(sorted.length * 4);
    for (let i = 0; i < sorted.length; i++) {
      crc32Table.writeUInt32BE(sorted[i]!.crc32 >>> 0, i * 4);
    }
    parts.push(crc32Table);

    // 写入偏移量表（分离普通偏移量和大偏移量）
    const offsetTable = Buffer.alloc(sorted.length * 4);
    const largeOffsets: number[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const offset = sorted[i]!.offset;
      if (offset >= 0x80000000) {
        // 大偏移量：存储索引到大偏移量表
        const largeIndex = largeOffsets.length;
        largeOffsets.push(offset);
        offsetTable.writeUInt32BE(0x80000000 | largeIndex, i * 4);
      } else {
        offsetTable.writeUInt32BE(offset, i * 4);
      }
    }
    parts.push(offsetTable);

    // 写入大偏移量表（如果有）
    if (largeOffsets.length > 0) {
      const largeOffsetTable = Buffer.alloc(largeOffsets.length * 8);
      for (let i = 0; i < largeOffsets.length; i++) {
        largeOffsetTable.writeBigUInt64BE(BigInt(largeOffsets[i]!), i * 8);
      }
      parts.push(largeOffsetTable);
    }

    // 写入 packfile 校验和
    parts.push(packChecksum);

    // 计算并写入索引文件校验和
    const idxWithoutChecksum = Buffer.concat(parts);
    const idxChecksum = createHash("sha1").update(idxWithoutChecksum).digest();

    return Buffer.concat([idxWithoutChecksum, idxChecksum]);
  }
}
