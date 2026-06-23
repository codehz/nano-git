/**
 * nano-git - 使用 TypeScript 实现的 Git 核心功能
 *
 * ## 设计理念
 *
 * 本库采用**按需加载**的入口设计：
 * - 默认入口（`"nano-git"`）仅导出核心类型和纯 TS 工具函数，**不包含任何后端实现**
 * - 后端实现按使用场景拆分到独立的子路径，让打包器可以 tree-shake 掉未使用的代码
 *
 * ## 子路径入口
 *
 * | 入口 | 内容 | 依赖 |
 * |------|------|------|
 * | `"nano-git"` | 核心类型 + SHA-1 + 错误类 | `node:crypto` |
 * | `nano-git/sha1` | SHA-1 哈希工具 | `node:crypto` |
 * | `nano-git/errors` | 所有错误类 | 纯定义 |
 * | `nano-git/hash-file` | 文件 SHA-1 计算 | `node:fs` |
 * | `nano-git/objects` | 对象序列化/反序列化 | 纯 TS |
 * | `nano-git/odb/memory` | 内存对象存储 | 纯 TS |
 * | `nano-git/odb/file` | 文件对象存储 | `node:fs` + `node:zlib` |
 * | `nano-git/pack` | Packfile 读写 | `node:fs` + `node:zlib` |
 * | `nano-git/refs/memory` | 内存 Refs 存储 | 纯 TS |
 * | `nano-git/refs/file` | 文件 Refs 存储 | `node:fs` |
 * | `nano-git/refs/shallow/memory` | 内存 Shallow 存储 | 纯 TS |
 * | `nano-git/refs/shallow/file` | 文件 Shallow 存储 | `node:fs` |
 * | `nano-git/repository/create` | 仓库创建（高阶函数） | 纯 TS |
 * | `nano-git/repository/memory` | 内存仓库便捷函数 | 仅 memory 后端 |
 * | `nano-git/repository/file` | 文件仓库便捷函数 | 完整 file 后端 |
 * | `nano-git/backend` | 仓库后端抽象 | 按后端类型 |
 * | `nano-git/transport` | 传输层协议原语（protocol/） | 纯 TS |
 */

// ============================================================================
// 核心类型
// ============================================================================

export type {
  SHA1,
  ObjectType,
  GitBlob,
  GitTree,
  GitCommit,
  GitCommitExtraHeader,
  GitTag,
  GitAuthor,
  TreeEntry,
  GitObject,
} from "./core/types.ts";

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
