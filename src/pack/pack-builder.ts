/**
 * Packfile 构建兼容出口
 *
 * 具体实现已迁移到 `src/odb/pack/pack-builder.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export { createPackBuilder, PackBuilder, type PackBuildResult } from "../odb/pack/pack-builder.ts";
