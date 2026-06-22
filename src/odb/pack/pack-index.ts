/**
 * Packfile 索引模块
 *
 * 拆分索引共享类型、读取器与写入器实现。
 */

export type { PackIndexEntry } from "./pack-index-types.ts";
export { createPackIndexReader } from "./pack-index-reader.ts";
export type { PackIndexReader } from "./pack-index-reader.ts";
export { createPackIndexWriter } from "./pack-index-writer.ts";
export type { PackIndexWriter } from "./pack-index-writer.ts";
