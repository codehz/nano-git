/**
 * Git 对象存储兼容出口
 *
 * 具体实现已迁移到 `src/odb/`，
 * 当前目录只保留原有导入路径的兼容层。
 */

export type { ObjectSource, ObjectStore } from "../odb/types.ts";
export { createFileObjectStore } from "../odb/file-store.ts";
export { createMemoryObjectStore, type MemoryObjectStore } from "../odb/memory-store.ts";
