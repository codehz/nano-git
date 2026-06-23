/**
 * 核心类型入口
 *
 * 集中导出所有跨模块公共类型。
 * 模块私有类型保留在各模块的本地 types.ts 中。
 */

// 基础 Git 类型（SHA1、ObjectType、GitObject 等）
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
} from "../types.ts";

export { sha1, assertObjectType } from "../types.ts";

// ODB 类型（ObjectSource、ObjectStore）
export type { ObjectSource, ObjectStore } from "./odb.ts";

// Refs 类型（RefStore、RefTransaction 等）
export { HEAD_REF, HEADS_PREFIX, TAGS_PREFIX } from "./refs.ts";

export type {
  RefStore,
  RefTransaction,
  ReadonlyRefTransaction,
  RefTransactionHook,
} from "./refs.ts";

// Shallow 类型（ShallowStore、ShallowUpdate）
export type { ShallowStore, ShallowUpdate } from "./shallow.ts";
