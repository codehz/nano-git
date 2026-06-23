/**
 * SHA-1 哈希工具入口
 *
 * 提供 SHA-1 类型构造、数据哈希计算与格式校验。
 * 唯一的外部依赖是 `node:crypto`。
 *
 * @example
 * ```ts
 * import { sha1, hashData } from "nano-git/sha1";
 *
 * const hash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
 * const digest = hashData(Buffer.from("hello world"));
 * ```
 */

export { sha1, assertObjectType } from "./core/types.ts";
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
} from "./core/types.ts";
export { hashData, hashObject } from "./core/hash-digest.ts";
export { isValidSHA1 } from "./core/hash-path.ts";
