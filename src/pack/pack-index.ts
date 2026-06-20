/**
 * Pack 索引兼容出口
 *
 * 具体实现已迁移到 `src/odb/pack/pack-index.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export {
  createPackIndexReader,
  createPackIndexWriter,
  PackIndexReader,
  PackIndexWriter,
  type PackIndexEntry,
} from "../odb/pack/pack-index.ts";
