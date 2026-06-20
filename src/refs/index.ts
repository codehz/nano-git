/**
 * Refs 模块
 *
 * 提供 Git 引用（分支、标签、HEAD）的存储和解析功能。
 *
 * 模块结构：
 * - types.ts: RefStore 接口定义和常量
 * - utils.ts: 引用解析、校验、名称转换等工具函数
 * - file-ref-store.ts: 文件系统实现
 * - memory-ref-store.ts: 内存实现
 *
 * @example
 * ```ts
 * import { createFileRefStore, resolveRefHash } from "../refs/index.ts";
 *
 * const store = createFileRefStore("/path/to/.git");
 * const hash = resolveRefHash(store, "refs/heads/main");
 * ```
 */

export type { RefStore } from "./types.ts";
export { HEAD_REF, HEADS_PREFIX, TAGS_PREFIX } from "./types.ts";

export {
  resolveRefHash,
  resolveSymbolicRef,
  resolveTargetHash,
  validateRefName,
  validateRefPrefix,
  branchNameToRef,
  tagNameToRef,
  normalizeShortRefName,
} from "./utils.ts";

export { createFileRefStore } from "./file-ref-store.ts";
export { createMemoryRefStore } from "./memory-ref-store.ts";
