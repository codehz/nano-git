/**
 * 文件系统 Refs 存储兼容出口
 *
 * 具体实现已迁移到 `src/refs/stores/file.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export { createFileRefStore } from "./stores/file.ts";
