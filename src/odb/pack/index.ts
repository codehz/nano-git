/**
 * ODB Packfile 模块
 *
 * 提供对象数据库使用的 Packfile 相关实现。
 */

export {
  OBJ_COMMIT,
  OBJ_TREE,
  OBJ_BLOB,
  OBJ_TAG,
  OBJ_OFS_DELTA,
  OBJ_REF_DELTA,
  PACK_SIGNATURE,
  PACK_VERSION,
  PACK_HEADER_SIZE,
  PACK_CHECKSUM_SIZE,
  IDX_V2_SIGNATURE,
  IDX_V2_VERSION,
  objectTypeToNumber,
  numberToObjectType,
  isDeltaType,
} from "./constants.ts";

export {
  decodeObjectHeader,
  encodeObjectHeader,
  decodeOfsDeltaOffset,
  encodeOfsDeltaOffset,
  decodeVarint,
  encodeVarint,
} from "./utils.ts";

export { applyDelta, createDelta } from "./delta.ts";
export { createPackReader, PackReader, type PackObject } from "./pack-reader.ts";
export { createPackWriter, PackWriter } from "./pack-writer.ts";
export {
  createPackIndexReader,
  createPackIndexWriter,
  PackIndexReader,
  PackIndexWriter,
  type PackIndexEntry,
} from "./pack-index.ts";
export { createPackObjectStore, PackObjectStore, type PackFileInfo } from "./pack-store.ts";
export { createCompositeObjectStore, CompositeObjectStore } from "./composite-store.ts";
export { createPackBuilder, PackBuilder, type PackBuildResult } from "./pack-builder.ts";
