/**
 * Packfile 读取兼容出口
 *
 * 具体实现已迁移到 `src/odb/pack/pack-reader.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export { createPackReader, PackReader, type PackObject } from "../odb/pack/pack-reader.ts";
