/**
 * Packfile 能力入口
 *
 * 聚合常用 pack 读写、索引和工具函数。
 */

export { createPackReader, packObjectToRaw } from "./reader/pack-reader.ts";
export type { PackObject } from "./reader/pack-reader.ts";

export { createPackIndexReader, createPackIndexWriter } from "./idx/pack-index.ts";
export type { PackIndexEntry, PackIndexReader, PackIndexWriter } from "./idx/pack-index.ts";

export { createPackBuilder } from "./builder/pack-builder.ts";
export type { PackBuildResult, PackBuilder } from "./builder/pack-builder.ts";

export { createPackObjectStore } from "./store/pack-store.ts";
export type { PackFileInfo, PackObjectStore } from "./store/pack-store.ts";

export { createMidxReader } from "./midx/midx-reader.ts";
export { loadIncrementalMidxChain } from "./midx/midx-chain.ts";
export type {
  CreateMidxReaderOptions,
  MidxBitmappedPack,
  MidxEntry,
  MidxHeader,
  MidxReader,
} from "./midx/midx-types.ts";

export {
  writeMultiPackIndex,
  writeMultiPackIndexFile,
  writeIncrementalMultiPackIndexFile,
} from "./midx/midx-writer.ts";
export type { MidxPackSource, WriteMultiPackIndexOptions } from "./midx/midx-writer.ts";

export { createPackBitmapReader } from "./bitmap/pack-bitmap-reader.ts";
export type { BitmapObjectTypeIndex, PackBitmapReader } from "./bitmap/pack-bitmap-reader.ts";
export { decodeEwahBitmap } from "./bitmap/ewah-bitmap.ts";
export type { UnpackedBitmap } from "./bitmap/ewah-bitmap.ts";

export {
  addReachableFromCommitBitmap,
  findMidxObjectPosition,
  loadPackMidxReader,
  resolveMidxTipChecksumHex,
  tryLoadMidxBitmapAssist,
  tryLoadTipMidxBitmap,
} from "./midx/midx-bitmap.ts";
export type { MidxBitmapAssist } from "./midx/midx-bitmap.ts";

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
