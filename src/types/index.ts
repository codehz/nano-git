/**
 * nano-git 公共类型入口
 *
 * 纯类型导出，编译期完全擦除。
 * 所有实现都引用此处的类型定义。
 */

export type {
  SHA1,
  ObjectType,
  GitBlob,
  GitTree,
  GitCommit,
  GitTag,
  GitAuthor,
  TreeEntry,
  GitObject,
} from "../core/types.ts";
