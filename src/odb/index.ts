/**
 * Git 对象数据库模块
 *
 * 聚合 loose object 存储与 Packfile 相关能力。
 */

export type { ObjectSource, ObjectStore } from "./types.ts";
export { createFileObjectStore } from "./file-store.ts";
export { createMemoryObjectStore, type MemoryObjectStore } from "./memory-store.ts";

export type { PackObject, PackIndexEntry, PackFileInfo, PackBuildResult } from "./pack/types.ts";

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
  decodeObjectHeader,
  encodeObjectHeader,
  decodeOfsDeltaOffset,
  encodeOfsDeltaOffset,
  decodeVarint,
  encodeVarint,
  applyDelta,
  createDelta,
  createPackReader,
  PackReader,
  createPackWriter,
  PackWriter,
  createPackIndexReader,
  createPackIndexWriter,
  PackIndexReader,
  PackIndexWriter,
  createPackObjectStore,
  PackObjectStore,
  createCompositeObjectStore,
  CompositeObjectStore,
  createPackBuilder,
  PackBuilder,
} from "./pack/index.ts";
