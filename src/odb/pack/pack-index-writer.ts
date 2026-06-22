/**
 * Packfile 索引写入
 */

import { createHash } from "node:crypto";

import {
  IDX_V2_FANOUT_SIZE,
  IDX_V2_HEADER_SIZE,
  IDX_V2_SIGNATURE,
  IDX_V2_VERSION,
} from "./constants.ts";

import type { PackIndexEntry } from "./pack-index-types.ts";

// ============================================================================
// 接口
// ============================================================================

/**
 * Packfile 索引写入器接口
 */
export interface PackIndexWriter {
  /**
   * 添加一个索引条目
   *
   * @param entry - 索引条目
   *
   * @example
   * ```ts
   * writer.addEntry({ hash, offset: 12, crc32: 0x12345678 });
   * ```
   */
  addEntry(entry: PackIndexEntry): void;

  /**
   * 构建索引文件数据
   *
   * @param packChecksum - packfile 的 SHA-1 校验和（20 字节）
   * @returns 完整的 .idx 文件数据
   *
   * @example
   * ```ts
   * const idxData = writer.build(packChecksum);
   * ```
   */
  build(packChecksum: Buffer): Buffer;
}

// ============================================================================
// 工厂函数
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
 * ```
 */
export function createPackIndexWriter(): PackIndexWriter {
  const entries: PackIndexEntry[] = [];

  /**
   * 构建头部
   */
  function createHeader(): Buffer {
    const header = Buffer.alloc(IDX_V2_HEADER_SIZE);
    IDX_V2_SIGNATURE.copy(header, 0);
    header.writeUInt32BE(IDX_V2_VERSION, 4);
    return header;
  }

  /**
   * 构建扇出表
   */
  function createFanoutTable(entries: PackIndexEntry[]): Buffer {
    const fanout = Buffer.alloc(IDX_V2_FANOUT_SIZE);
    let count = 0;

    for (let i = 0; i < 256; i++) {
      while (count < entries.length && parseInt(entries[count]!.hash.slice(0, 2), 16) <= i) {
        count++;
      }
      fanout.writeUInt32BE(count, i * 4);
    }

    return fanout;
  }

  /**
   * 构建 SHA-1 表
   */
  function createSha1Table(entries: PackIndexEntry[]): Buffer {
    const sha1Table = Buffer.alloc(entries.length * 20);
    for (let i = 0; i < entries.length; i++) {
      Buffer.from(entries[i]!.hash, "hex").copy(sha1Table, i * 20);
    }
    return sha1Table;
  }

  /**
   * 构建 CRC32 表
   */
  function createCrc32Table(entries: PackIndexEntry[]): Buffer {
    const crc32Table = Buffer.alloc(entries.length * 4);
    for (let i = 0; i < entries.length; i++) {
      crc32Table.writeUInt32BE(entries[i]!.crc32 >>> 0, i * 4);
    }
    return crc32Table;
  }

  /**
   * 构建偏移量表与大偏移量列表
   */
  function createOffsetTables(entries: PackIndexEntry[]): {
    offsetTable: Buffer;
    largeOffsets: number[];
  } {
    const offsetTable = Buffer.alloc(entries.length * 4);
    const largeOffsets: number[] = [];

    for (let i = 0; i < entries.length; i++) {
      const offset = entries[i]!.offset;
      if (offset >= 0x80000000) {
        const largeIndex = largeOffsets.length;
        largeOffsets.push(offset);
        offsetTable.writeUInt32BE(0x80000000 | largeIndex, i * 4);
      } else {
        offsetTable.writeUInt32BE(offset, i * 4);
      }
    }

    return { offsetTable, largeOffsets };
  }

  /**
   * 构建大偏移量表
   */
  function createLargeOffsetTable(largeOffsets: number[]): Buffer {
    const largeOffsetTable = Buffer.alloc(largeOffsets.length * 8);
    for (let i = 0; i < largeOffsets.length; i++) {
      largeOffsetTable.writeBigUInt64BE(BigInt(largeOffsets[i]!), i * 8);
    }
    return largeOffsetTable;
  }

  return {
    addEntry(entry: PackIndexEntry): void {
      entries.push(entry);
    },

    build(packChecksum: Buffer): Buffer {
      const sorted = [...entries].sort((a, b) => a.hash.localeCompare(b.hash));
      const parts: Buffer[] = [];

      parts.push(createHeader());
      parts.push(createFanoutTable(sorted));
      parts.push(createSha1Table(sorted));
      parts.push(createCrc32Table(sorted));

      const { offsetTable, largeOffsets } = createOffsetTables(sorted);
      parts.push(offsetTable);

      if (largeOffsets.length > 0) {
        parts.push(createLargeOffsetTable(largeOffsets));
      }

      parts.push(packChecksum);

      const idxWithoutChecksum = Buffer.concat(parts);
      const idxChecksum = createHash("sha1").update(idxWithoutChecksum).digest();
      return Buffer.concat([idxWithoutChecksum, idxChecksum]);
    },
  };
}
