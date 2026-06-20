/**
 * Refs 工具兼容出口
 *
 * 具体实现已拆分到 `src/refs/names.ts`、`resolve.ts`、`fs-utils.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export { resolveRefHash, resolveSymbolicRef, resolveTargetHash } from "./resolve.ts";
export {
  validateRefName,
  validateRefPrefix,
  branchNameToRef,
  tagNameToRef,
  normalizeShortRefName,
} from "./names.ts";
export { listLooseRefsRecursive } from "./fs-utils.ts";
