/**
 * 核心模块
 *
 * 聚合基础类型、错误和哈希工具。
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
} from "./types.ts";
export { sha1 } from "./types.ts";

export {
  GitError,
  ObjectNotFoundError,
  InvalidObjectError,
  InvalidSHA1Error,
  RepositoryError,
  CircularReferenceError,
  RefNotFoundError,
  PackError,
  InvalidPackError,
  PackIndexError,
  DeltaError,
  PreconditionCheckError,
} from "./errors.ts";

export { hashData, hashObject, hashToPath, pathToHash, isValidSHA1, hashFile } from "./hash.ts";
