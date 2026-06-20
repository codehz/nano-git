/**
 * Git 对象存储
 *
 * 统一导出对象存储接口和各种实现。
 *
 * 扩展点：添加新存储后端时，在此处导出即可。
 */

export type { ObjectSource, ObjectStore } from "./types.ts";
export { createFileObjectStore } from "./file-store.ts";
export { createMemoryObjectStore, type MemoryObjectStore } from "./memory-store.ts";
