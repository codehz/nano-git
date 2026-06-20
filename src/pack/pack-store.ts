/**
 * Pack 对象存储兼容出口
 *
 * 具体实现已迁移到 `src/odb/pack/pack-store.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export {
  createPackObjectStore,
  PackObjectStore,
  type PackFileInfo,
} from "../odb/pack/pack-store.ts";
