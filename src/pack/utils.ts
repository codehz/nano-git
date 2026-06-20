/**
 * Packfile 工具兼容出口
 *
 * 具体实现已迁移到 `src/odb/pack/utils.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export {
  decodeObjectHeader,
  encodeObjectHeader,
  decodeOfsDeltaOffset,
  encodeOfsDeltaOffset,
  decodeVarint,
  encodeVarint,
} from "../odb/pack/utils.ts";
