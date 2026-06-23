/**
 * Refs 模块
 *
 * 提供 Git 引用（分支、标签、HEAD）的存储和解析功能。
 *
 * 模块结构：
 * - types.ts: RefStore 接口定义和常量
 * - names.ts: 引用名校验与名称转换
 * - resolve.ts: 符号引用解析
 * - stores/: 文件系统与内存实现
 *
 * @example
 * ```ts
 * import { createFileRefStore, resolveRefHash } from "../refs/index.ts";
 *
 * const store = createFileRefStore("/path/to/.git");
 * const hash = resolveRefHash(store, "refs/heads/main");
 * ```
 */

export type {
  RefStore,
  RefTransaction,
  ReadonlyRefTransaction,
  RefTransactionHook,
} from "./types.ts";
export { HEAD_REF, HEADS_PREFIX, TAGS_PREFIX } from "./types.ts";

export { resolveRefHash, resolveSymbolicRef, resolveTargetHash } from "./resolve.ts";

export {
  validateRefName,
  validateRefPrefix,
  branchNameToRef,
  tagNameToRef,
  normalizeShortRefName,
} from "./names.ts";

export { createFileRefStore } from "./file.ts";
export { createMemoryRefStore } from "./memory.ts";
