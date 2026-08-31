/**
 * 文件系统 Packfile 能力入口
 *
 * 本入口包含 pack 目录扫描、文件读写和 MIDX 文件维护。
 */

export { createPackBuilder } from "./builder/pack-builder.ts";
export type { PackBuildResult, PackBuilder } from "./types.ts";

export { createPackObjectStore } from "./store/pack-store.ts";
export type { PackFileInfo, PackObjectStore } from "./store/pack-store.ts";

export { loadIncrementalMidxChain } from "./midx/midx-chain.ts";
export { writeMultiPackIndexFile, writeIncrementalMultiPackIndexFile } from "./midx/midx-writer.ts";
export {
  loadPackMidxReader,
  resolveMidxTipChecksumHex,
  tryLoadMidxBitmapAssist,
  tryLoadTipMidxBitmap,
} from "./midx/midx-bitmap.ts";
export type { MidxBitmapAssist } from "./midx/midx-bitmap-core.ts";
