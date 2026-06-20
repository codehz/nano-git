/**
 * Delta 工具兼容出口
 *
 * 具体实现已迁移到 `src/odb/pack/delta.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export { applyDelta, createDelta } from "../odb/pack/delta.ts";
