/**
 * 文件系统对象存储兼容出口
 *
 * 具体实现已迁移到 `src/odb/file-store.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export { createFileObjectStore } from "../odb/file-store.ts";
