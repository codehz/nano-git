/**
 * nano-git - 使用 TypeScript 实现的 Git 核心功能
 *
 * ## 设计理念
 *
 * 本库采用“默认入口提供高频纯能力，运行时边界通过子路径隔离”的设计：
 * - 默认入口（`"nano-git"`）导出常用类型、对象编解码、refs 工具与纯计算函数
 * - `node:fs` / `node:zlib` 等运行时相关能力仍通过子路径显式导入
 * - tree-shaking 依赖模块本身的无副作用结构，而不是把所有函数都拆成叶子级子路径
 *
 * ## 子路径入口
 *
 * | 入口 | 内容 | 依赖 |
 * |------|------|------|
 * | `"nano-git"` | 常用类型 + SHA-1 + 对象编解码 + refs 工具 | `node:crypto` |
 * | `nano-git/sha1` | SHA-1 哈希工具 | `node:crypto` |
 * | `nano-git/errors` | 所有错误类 | 纯定义 |
 * | `nano-git/hash-file` | 文件 SHA-1 计算 | `node:fs` |
 * | `nano-git/objects` | 对象序列化/反序列化 + raw 转换 helper | `node:crypto` |
 * | `nano-git/pack` | Packfile 读写与索引 | `node:fs` + `node:zlib` |
 * | `nano-git/backend` | 仓库后端抽象类型 | 类型 |
 * | `nano-git/backend/memory` | 内存后端实现 | 纯 TS |
 * | `nano-git/backend/file` | 文件后端实现 | `node:fs` + `node:zlib` |
 * | `nano-git/repository/core` | 通用仓库拼装 | 纯 TS |
 * | `nano-git/repository/memory` | 内存仓库便捷函数 | 纯 TS |
 * | `nano-git/repository/file` | 文件仓库便捷函数 | `node:fs` + `node:zlib` |
 * | `nano-git/repository/sqlite` | SQLite 仓库便捷函数 | `bun:sqlite` |
 * | `nano-git/backend/sqlite` | SQLite 仓库后端（组合工厂） | `bun:sqlite` |
 * | `nano-git/odb/sqlite` | SQLite 对象存储 | `bun:sqlite` |
 * | `nano-git/refs/sqlite` | SQLite 引用存储 | `bun:sqlite` |
 * | `nano-git/refs/shallow/sqlite` | SQLite shallow 边界存储 | `bun:sqlite` |
 * | `nano-git/transport` | 传输层协议原语 | `node:crypto` |
 * | `nano-git/transport/upload-pack` | upload-pack 客户端 | `node:crypto` + `node:zlib` |
 * | `nano-git/transport/receive-pack` | receive-pack 客户端 | `node:crypto` + `node:zlib` |
 * | `nano-git/transport/http` | Smart HTTP 服务端适配 | `node:http` + `node:fs` + `node:zlib` |
 */

// ============================================================================
// 核心类型
// ============================================================================

export type {
  SHA1,
  ObjectType,
  RawGitObject,
  GitBlob,
  GitTree,
  GitCommit,
  GitCommitExtraHeader,
  GitTag,
  GitAuthor,
  TreeEntry,
  GitObject,
} from "./core/types.ts";
export type {
  RepositoryBackend,
  RepositoryGCOptions,
  RepositoryPackSupport,
  RepositoryRepackOptions,
  PackRepackOptions,
} from "./backend/types.ts";
export type { Repository, FileRepository } from "./repository/types.ts";

// ============================================================================
// SHA-1 哈希工具（仅 node:crypto）
// ============================================================================

export { sha1, assertObjectType } from "./core/types.ts";
export { hashData, hashObject, isValidSHA1 } from "./core/hash.ts";

// ============================================================================
// 错误类型（纯定义）
// ============================================================================

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
  TransactionError,
  PreconditionCheckError,
} from "./core/errors.ts";

// ============================================================================
// 对象编解码
// ============================================================================

export {
  serializeBlob,
  deserializeBlob,
  serializeTree,
  deserializeTree,
  serializeCommit,
  deserializeCommit,
  serializeTag,
  deserializeTag,
  formatAuthor,
  parseAuthor,
  serialize,
  deserialize,
  serializeContent,
  deserializeContent,
  encodeObject,
  decodeObject,
  writeObject,
  readObject,
  tryReadObject,
} from "./objects/index.ts";

// ============================================================================
// Refs 工具
// ============================================================================

export {
  validateRefPrefix,
  validateRefName,
  branchNameToRef,
  tagNameToRef,
  normalizeShortRefName,
} from "./refs/names.ts";
export { resolveRefHash, resolveSymbolicRef, resolveTargetHash } from "./refs/resolve.ts";
