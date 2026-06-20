/**
 * 核心类型兼容出口
 *
 * 具体实现已迁移到 `src/core/types.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export type {
  SHA1,
  ObjectType,
  GitObject,
  GitBlob,
  GitTree,
  GitCommit,
  GitTag,
  TreeEntry,
  GitAuthor,
} from "./core/types.ts";
export { sha1 } from "./core/types.ts";
