/**
 * Packfile 写入兼容出口
 *
 * 具体实现已迁移到 `src/odb/pack/pack-writer.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export { createPackWriter, PackWriter } from "../odb/pack/pack-writer.ts";
