/**
 * Shallow 模块
 *
 * 提供 Git shallow 边界（浅仓库状态）的存储抽象。
 * 遵循与 ObjectStore、RefStore 相同的接口模式。
 *
 * 模块结构：
 * - types.ts: ShallowStore 接口定义和 ShallowUpdate 类型
 * - file.ts: 文件系统实现（读写 .git/shallow）
 * - memory.ts: 内存实现（用于测试）
 *
 * @example
 * ```ts
 * import { createFileShallowStore } from "../shallow/index.ts";
 *
 * const store = createFileShallowStore("/path/to/.git");
 * const boundaries = store.read();
 * ```
 */

export type { ShallowStore, ShallowUpdate } from "./types.ts";
export { createFileShallowStore } from "./file.ts";
export { createMemoryShallowStore } from "./memory.ts";
