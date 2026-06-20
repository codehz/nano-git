/**
 * Packfile 模块
 *
 * 提供 Git Packfile 的完整支持：
 * - 读取和解析 packfile（.pack 文件）
 * - 读取和解析索引文件（.idx 文件）
 * - 创建新的 packfile 和索引
 * - 基于 packfile 的对象存储
 * - 组合多个存储后端
 *
 * Packfile 是 Git 用于高效存储和传输对象的二进制格式。
 * 它将多个对象打包成一个文件，支持 delta 压缩，
 * 并使用索引文件实现快速查找。
 *
 * @example
 * ```ts
 * import { createPackBuilder, createPackObjectStore } from "nano-git";
 *
 * // 创建新的 packfile
 * const builder = createPackBuilder(gitDir);
 * builder.addObject(blob);
 * builder.addObject(commit);
 * const result = builder.build();
 *
 * // 从 packfile 读取对象
 * const store = createPackObjectStore(gitDir);
 * const obj = store.read(hash);
 * ```
 */

// ============================================================================
// 常量和工具
// ============================================================================

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

// ============================================================================
// Delta 编解码
// ============================================================================

export { applyDelta, createDelta } from "./delta.ts";

// ============================================================================
// Packfile 读取
// ============================================================================

export { createPackReader, PackReader, type PackObject } from "./pack-reader.ts";

// ============================================================================
// Packfile 写入
// ============================================================================

export { createPackWriter, PackWriter } from "./pack-writer.ts";

// ============================================================================
// Packfile 索引
// ============================================================================

export {
  createPackIndexReader,
  createPackIndexWriter,
  PackIndexReader,
  PackIndexWriter,
  type PackIndexEntry,
} from "./pack-index.ts";

// ============================================================================
// Packfile 存储
// ============================================================================

export { createPackObjectStore, PackObjectStore } from "./pack-store.ts";

// ============================================================================
// 组合存储
// ============================================================================

export { createCompositeObjectStore, CompositeObjectStore } from "./composite-store.ts";

// ============================================================================
// Packfile 构建器
// ============================================================================

export { createPackBuilder, PackBuilder, type PackBuildResult } from "./pack-builder.ts";
