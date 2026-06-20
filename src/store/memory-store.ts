/**
 * 内存对象存储兼容出口
 *
 * 具体实现已迁移到 `src/odb/memory-store.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export { createMemoryObjectStore, type MemoryObjectStore } from "../odb/memory-store.ts";
