/**
 * 纯 Packfile 能力入口
 *
 * 本入口不访问文件系统。
 */

export { createPackReader, packObjectToRaw } from "./reader/pack-reader.ts";
export type { PackObject } from "./reader/pack-reader-types.ts";

export { createPackIndexReader, createPackIndexWriter } from "./idx/pack-index.ts";
export type { PackIndexEntry, PackIndexReader, PackIndexWriter } from "./idx/pack-index.ts";

export { createMidxReader } from "./midx/midx-reader.ts";
export type {
  CreateMidxReaderOptions,
  MidxBitmappedPack,
  MidxEntry,
  MidxHeader,
  MidxReader,
} from "./midx/midx-types.ts";
export { writeMultiPackIndex } from "./midx/midx-writer-core.ts";
export type { MidxPackSource, WriteMultiPackIndexOptions } from "./midx/midx-writer-core.ts";
export {
  addReachableFromCommitBitmap,
  createMidxReachabilityAccelerator,
  findMidxObjectPosition,
} from "./midx/midx-bitmap-core.ts";
export type { MidxBitmapAssist } from "./midx/midx-bitmap-core.ts";

export { createPackBitmapReader } from "./bitmap/pack-bitmap-reader.ts";
export type { BitmapObjectTypeIndex, PackBitmapReader } from "./bitmap/pack-bitmap-reader.ts";
export { decodeEwahBitmap } from "./bitmap/ewah-bitmap.ts";
export type { UnpackedBitmap } from "./bitmap/ewah-bitmap.ts";

export { createCompositeObjectDatabase, CompositeObjectDatabase } from "./composite-store.ts";
export { applyDelta, createDelta } from "./delta/delta.ts";
export {
  decodeObjectHeader,
  encodeObjectHeader,
  decodeOfsDeltaOffset,
  encodeOfsDeltaOffset,
  decodeVarint,
  encodeVarint,
} from "./utils/utils.ts";

export type { PackBuildResult, PackBuilder, PackFileInfo, PackRepackOptions } from "./types.ts";
