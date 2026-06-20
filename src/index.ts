/**
 * nano-git - 使用 TypeScript 实现的 Git 核心功能
 *
 * 本项目实现了 Git 的基本数据结构和算法，包括：
 * - SHA-1 哈希计算
 * - Git 对象（blob, tree, commit, tag）的序列化/反序列化
 * - 对象存储（文件系统和内存）
 * - 仓库操作 API（init, hash-object, cat-file, write-tree, commit-tree, refs 等）
 * - Packfile 支持（读取、写入、索引、delta 编解码、打包）
 *
 * 模块结构：
 * - types.ts: 核心类型定义
 * - errors.ts: 错误类型体系
 * - hash.ts: SHA-1 哈希工具
 * - objects/: 对象序列化/反序列化（按类型拆分）
 * - store/: 对象存储（按实现拆分）
 * - refs/: 引用管理（分支、标签操作）
 * - pack/: Packfile 支持
 * - repository.ts: 高层仓库 API
 *
 * 扩展点：
 * - diff/: 差异计算
 * - transport/: 远程传输协议
 *
 * @example
 * ```ts
 * import { createMemoryRepository } from "nano-git";
 *
 * const repo = createMemoryRepository();
 * const hash = repo.writeBlob(Buffer.from("hello world"));
 * console.log(hash); // => "95d09f2b10159347eece71399a7e2e907ea3df4f"
 * ```
 */

// ============================================================================
// 核心类型
// ============================================================================

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

// ============================================================================
// 错误类型
// ============================================================================

export {
  GitError,
  ObjectNotFoundError,
  InvalidObjectError,
  InvalidSHA1Error,
  RepositoryError,
  CircularReferenceError,
  RefNotFoundError,
} from "./errors.ts";

// ============================================================================
// 哈希工具
// ============================================================================

export { hashData, hashObject, hashToPath, pathToHash, isValidSHA1, hashFile } from "./hash.ts";

// ============================================================================
// 对象序列化/反序列化
// ============================================================================

export {
  serialize,
  deserialize,
  serializeContent,
  deserializeContent,
  // 各类型序列化函数（高级用法）
  serializeBlob,
  deserializeBlob,
  serializeTree,
  deserializeTree,
  serializeCommit,
  deserializeCommit,
  serializeTag,
  deserializeTag,
  // 作者信息工具
  formatAuthor,
  parseAuthor,
} from "./objects/index.ts";

// ============================================================================
// 对象存储
// ============================================================================

export {
  createFileObjectStore,
  createMemoryObjectStore,
  type ObjectStore,
  type MemoryObjectStore,
} from "./store/index.ts";

// ============================================================================
// Packfile 支持
// ============================================================================

export {
  // 常量和工具
  OBJ_COMMIT,
  OBJ_TREE,
  OBJ_BLOB,
  OBJ_TAG,
  OBJ_OFS_DELTA,
  OBJ_REF_DELTA,
  objectTypeToNumber,
  numberToObjectType,
  isDeltaType,
  // Delta 编解码
  applyDelta,
  createDelta,
  // Packfile 读取
  createPackReader,
  PackReader,
  type PackObject,
  // Packfile 写入
  createPackWriter,
  PackWriter,
  // Packfile 索引
  createPackIndexReader,
  createPackIndexWriter,
  PackIndexReader,
  PackIndexWriter,
  type PackIndexEntry,
  // Packfile 存储
  createPackObjectStore,
  PackObjectStore,
  // 组合存储
  createCompositeObjectStore,
  CompositeObjectStore,
  // Packfile 构建器
  createPackBuilder,
  PackBuilder,
  type PackBuildResult,
} from "./pack/index.ts";

// ============================================================================
// Refs 支持
// ============================================================================

export type { RefStore } from "./refs/index.ts";
export {
  HEAD_REF,
  HEADS_PREFIX,
  TAGS_PREFIX,
  resolveRefHash,
  resolveSymbolicRef,
  resolveTargetHash,
  validateRefName,
  validateRefPrefix,
  branchNameToRef,
  tagNameToRef,
  createFileRefStore,
  createMemoryRefStore,
} from "./refs/index.ts";

// ============================================================================
// 仓库后端
// ============================================================================

export {
  createFileRepositoryBackend,
  createMemoryRepositoryBackend,
  type CreateFileRepositoryBackendOptions,
  type CreateMemoryRepositoryBackendOptions,
  type RepositoryGCOptions,
  type RepositoryPackSupport,
  type RepositoryRepackOptions,
  type RepositoryBackend,
} from "./backend/index.ts";

// ============================================================================
// 仓库 API
// ============================================================================

export {
  createRepository,
  initRepository,
  openRepository,
  createMemoryRepository,
  type Repository,
} from "./repository.ts";
