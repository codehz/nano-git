/**
 * Packfile 能力入口
 *
 * 聚合常用 pack 读写、索引和工具函数。
 */

export { createPackReader, packObjectToRaw } from "./pack-reader.ts";
export type { PackObject } from "./pack-reader.ts";

export { createPackIndexReader, createPackIndexWriter } from "./pack-index.ts";
export type { PackIndexEntry, PackIndexReader, PackIndexWriter } from "./pack-index.ts";

export { createPackBuilder } from "./pack-builder.ts";
export type { PackBuildResult, PackBuilder } from "./pack-builder.ts";

export { createPackObjectStore } from "./pack-store.ts";
export type { PackFileInfo, PackObjectStore } from "./pack-store.ts";

export { createMidxReader } from "./midx-reader.ts";
export type { CreateMidxReaderOptions, MidxEntry, MidxHeader, MidxReader } from "./midx-types.ts";
export { writeMultiPackIndex, writeMultiPackIndexFile } from "./midx-writer.ts";
export type { MidxPackSource, WriteMultiPackIndexOptions } from "./midx-writer.ts";

export { createCompositeObjectDatabase, CompositeObjectDatabase } from "./composite-store.ts";

export { applyDelta, createDelta } from "./delta.ts";
export {
  decodeObjectHeader,
  encodeObjectHeader,
  decodeOfsDeltaOffset,
  encodeOfsDeltaOffset,
  decodeVarint,
  encodeVarint,
} from "./utils.ts";
