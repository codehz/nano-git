/**
 * Packfile 常量兼容出口
 *
 * 具体实现已迁移到 `src/odb/pack/constants.ts`，
 * 当前文件只保留原有导入路径的兼容层。
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
  IDX_V2_HEADER_SIZE,
  IDX_V2_FANOUT_SIZE,
  objectTypeToNumber,
  numberToObjectType,
  isDeltaType,
} from "../odb/pack/constants.ts";
