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

import { createMidxReaderFromTip, parseMidxLayer } from "./midx-layer.ts";

import type { CreateMidxReaderOptions, MidxReader } from "./midx-types.ts";

/**
 * 创建 MIDX 读取器（经典单文件）
 *
 * @param data - 完整的 `multi-pack-index` 文件数据
 * @param options - 可选构造参数
 * @returns MIDX 读取器实例
 *
 * @example
 * ```ts
 * const midx = createMidxReader(data);
 * console.log(midx.objectCount);
 * ```
 */
export function createMidxReader(data: Buffer, options?: CreateMidxReaderOptions): MidxReader {
  const layer = parseMidxLayer(data, options);
  return createMidxReaderFromTip(layer);
}
