/**
 * Git chunk-based 文件格式通用解析器
 *
 * Git 的 MIDX、commit-graph 等格式都使用 chunk lookup 表来定位变长数据区。
 * 本模块提供对 chunk lookup 表的解析，供 MIDX 读取器复用。
 *
 * chunk lookup 表结构：
 * - (C + 1) 项，每项 12 字节
 * - 4 字节 chunk id（四字符 ASCII，如 `PNAM`）
 * - 8 字节 chunk 在文件中的起始偏移
 * - chunk id 为 `0`（四字节全 0）表示表结束
 *
 * @example
 * ```ts
 * const chunks = parseChunkLookup(data, headerSize, chunkCount);
 * const pnamOffset = chunks.get("PNAM");
 * ```
 */

import { PackIndexError } from "../core/errors.ts";

// ============================================================================
// 类型
// ============================================================================

/**
 * chunk lookup 表解析结果
 */
export interface ChunkLookupTable {
  /**
   * 获取指定 chunk id 的起始偏移
   *
   * @param id - 四字符 ASCII chunk id
   * @returns 起始偏移，不存在时返回 undefined
   */
  get(id: string): number | undefined;

  /**
   * 获取所有 chunk id 列表
   */
  ids(): string[];
}

// ============================================================================
// 解析
// ============================================================================

/**
 * 解析 chunk lookup 表
 *
 * @param data - 完整文件数据
 * @param headerSize - 文件头大小（lookup 表起始偏移）
 * @param chunkCount - header 中声明的 chunk 数量
 * @returns chunk lookup 表
 *
 * @example
 * ```ts
 * const chunks = parseChunkLookup(data, 12, 4);
 * const pnam = chunks.get("PNAM");
 * if (pnam === undefined) {
 *   throw new Error("missing PNAM chunk");
 * }
 * ```
 */
export function parseChunkLookup(
  data: Buffer,
  headerSize: number,
  chunkCount: number,
): ChunkLookupTable {
  const lookupStart = headerSize;
  const lookupSize = (chunkCount + 1) * 12;

  if (data.length < lookupStart + lookupSize) {
    throw new PackIndexError("Chunk lookup table truncated");
  }

  const offsets = new Map<string, number>();

  for (let i = 0; i <= chunkCount; i++) {
    const entryOffset = lookupStart + i * 12;
    const idBytes = data.subarray(entryOffset, entryOffset + 4);

    // 四字节全 0 表示表结束
    if (idBytes[0] === 0 && idBytes[1] === 0 && idBytes[2] === 0 && idBytes[3] === 0) {
      break;
    }

    const id = idBytes.toString("ascii");
    const chunkOffset = Number(data.readBigUInt64BE(entryOffset + 4));

    if (chunkOffset > data.length) {
      throw new PackIndexError(`Chunk ${id} offset out of bounds: ${chunkOffset}`);
    }

    offsets.set(id, chunkOffset);
  }

  return {
    get(id: string): number | undefined {
      return offsets.get(id);
    },
    ids(): string[] {
      return Array.from(offsets.keys());
    },
  };
}
