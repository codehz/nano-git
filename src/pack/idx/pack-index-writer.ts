/**
 * Packfile 索引写入
 */

import { createHash } from "node:crypto";

import {
  allocBytes,
  concatBytes,
  copyBytes,
  hexToBytes,
  writeU32BE,
  writeU64BE,
} from "../../bytes.ts";
import {
  IDX_V2_FANOUT_SIZE,
  IDX_V2_HEADER_SIZE,
  IDX_V2_SIGNATURE,
  IDX_V2_VERSION,
} from "../constants.ts";

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
  build(packChecksum: Uint8Array): Uint8Array;
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
  function createHeader(): Uint8Array {
    const header = allocBytes(IDX_V2_HEADER_SIZE);
    copyBytes(header, 0, IDX_V2_SIGNATURE);
    writeU32BE(header, 4, IDX_V2_VERSION);
    return header;
  }

  /**
   * 构建扇出表
   */
  function createFanoutTable(entries: PackIndexEntry[]): Uint8Array {
    const fanout = allocBytes(IDX_V2_FANOUT_SIZE);
    let count = 0;

    for (let i = 0; i < 256; i++) {
      while (count < entries.length && parseInt(entries[count]!.hash.slice(0, 2), 16) <= i) {
        count++;
      }
      writeU32BE(fanout, i * 4, count);
    }

    return fanout;
  }

  /**
   * 构建 SHA-1 表
   */
  function createSha1Table(entries: PackIndexEntry[]): Uint8Array {
    const sha1Table = allocBytes(entries.length * 20);
    for (let i = 0; i < entries.length; i++) {
      copyBytes(sha1Table, i * 20, hexToBytes(entries[i]!.hash));
    }
    return sha1Table;
  }

  /**
   * 构建 CRC32 表
   */
  function createCrc32Table(entries: PackIndexEntry[]): Uint8Array {
    const crc32Table = allocBytes(entries.length * 4);
    for (let i = 0; i < entries.length; i++) {
      writeU32BE(crc32Table, i * 4, entries[i]!.crc32 >>> 0);
    }
    return crc32Table;
  }

  /**
   * 构建偏移量表与大偏移量列表
   */
  function createOffsetTables(entries: PackIndexEntry[]): {
    offsetTable: Uint8Array;
    largeOffsets: number[];
  } {
    const offsetTable = allocBytes(entries.length * 4);
    const largeOffsets: number[] = [];

    for (let i = 0; i < entries.length; i++) {
      const offset = entries[i]!.offset;
      if (offset >= 0x80000000) {
        const largeIndex = largeOffsets.length;
        largeOffsets.push(offset);
        writeU32BE(offsetTable, i * 4, (0x80000000 | largeIndex) >>> 0);
      } else {
        writeU32BE(offsetTable, i * 4, offset);
      }
    }

    return { offsetTable, largeOffsets };
  }

  /**
   * 构建大偏移量表
   */
  function createLargeOffsetTable(largeOffsets: number[]): Uint8Array {
    const largeOffsetTable = allocBytes(largeOffsets.length * 8);
    for (let i = 0; i < largeOffsets.length; i++) {
      writeU64BE(largeOffsetTable, i * 8, BigInt(largeOffsets[i]!));
    }
    return largeOffsetTable;
  }

  return {
    addEntry(entry: PackIndexEntry): void {
      entries.push(entry);
    },

    build(packChecksum: Uint8Array): Uint8Array {
      const sorted = [...entries].sort((a, b) => a.hash.localeCompare(b.hash));
      const parts: Uint8Array[] = [];

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

      const idxWithoutChecksum = concatBytes(...parts);
      const idxChecksum = createHash("sha1").update(idxWithoutChecksum).digest();
      return concatBytes(idxWithoutChecksum, idxChecksum);
    },
  };
}
