/**
 * nano-git - 使用 TypeScript 实现的 Git 核心功能
 *
 * ## 设计理念
 *
 * 本库采用“核心能力与运行时后端分层”的设计：
 * - 默认入口和 core/repository/sqlite/memory 入口不引用文件系统或 MIDX 文件实现
 * - 文件系统能力通过 `repository/file`、`pack/file` 等明确子路径导入
 * - 纯 Pack 类型通过 `pack/types` 与 `backend/pack` 导入，不经过运行时实现
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
 * | `nano-git/pack/core` | 纯 Pack 解析、编码、IDX、MIDX parser | `node:crypto` + `node:zlib` |
 * | `nano-git/pack/file` | Pack 目录、builder、store、MIDX 文件操作 | `node:fs` + `node:path` |
 * | `nano-git/pack/types` | Pack 能力纯类型 | 纯类型 |
 * | `nano-git/backend` | 核心仓库后端抽象类型 | 纯类型 |
 * | `nano-git/backend/pack` | Pack 仓库后端抽象类型 | 纯类型 |
 * | `nano-git/backend/memory` | 内存后端实现 | 纯 TS |
 * | `nano-git/backend/file` | 文件后端实现 | `node:fs` + `node:zlib` |
 * | `nano-git/remote/http` | 纯远端查询 API | `fetch` + `node:crypto` |
 * | `nano-git/repository/core` | 核心仓库拼装 | 纯 TS + 网络 pack 编解码 |
 * | `nano-git/repository/pack` | 自定义 Pack backend 仓库拼装 | 纯 TS |
 * | `nano-git/repository/memory` | 内存仓库便捷函数 | 纯 TS + 网络 pack 编解码 |
 * | `nano-git/repository/file` | 文件仓库便捷函数 | `node:fs` + `node:zlib` |
 * | `nano-git/repository/sqlite` | SQLite 仓库便捷函数 | 注入 `SqliteDatabase` + 网络 pack 编解码 |
 * | `nano-git/backend/sqlite` | SQLite 仓库后端（组合工厂） | 注入 `SqliteDatabase` |
 * | `nano-git/odb/sqlite` | SQLite 对象存储 | 注入 `SqliteDatabase` |
 * | `nano-git/refs/sqlite` | SQLite 引用存储 | 注入 `SqliteDatabase` |
 * | `nano-git/refs/shallow/sqlite` | SQLite shallow 边界存储 | 注入 `SqliteDatabase` |
 * | `nano-git/transport` | 传输层协议原语 | `node:crypto` |
 * | `nano-git/transport/upload-pack` | upload-pack 客户端 | `node:crypto` + `node:zlib` |
 * | `nano-git/transport/receive-pack` | receive-pack 客户端 | `node:crypto` + `node:zlib` |
 * | `nano-git/transport/http` | Smart HTTP 服务端适配 | `node:http` + `node:fs` + `node:zlib` |
 * | `nano-git/log` | 提交历史遍历（git-log 风格） | `node:crypto` |
 * | `nano-git/merge` | merge-base + 三方 tree 合并 + 交互会话 | `node:crypto` |
 * | `nano-git/worktree/core` | Virtual Worktree 类型与错误 | 纯 TS |
 * | `nano-git/worktree/memory` | 内存 Virtual Worktree | 纯 TS |
 * | `nano-git/worktree/file` | 目录持久化 Virtual Worktree | `node:fs` |
 * | `nano-git/worktree/sqlite` | SQLite 持久化 Virtual Worktree | 注入 `SqliteDatabase` |
 * | `nano-git/types/sqlite` | 最小 SQLite 接口类型 | 纯类型 |
 *
 * SQLite 相关入口不捆绑具体驱动；调用方注入符合 `SqliteDatabase` 的已打开连接
 *（如 `bun:sqlite`、`node:sqlite` 或自行适配的实现）。
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
} from "./types/index.ts";
export type { RepositoryBackend, RepositoryGCOptions } from "./backend/types.ts";
export type { HttpAuth, RemoteSource } from "./remote/types.ts";
export type { Repository } from "./repository/types.ts";
export type { ReachabilityAccelerator } from "./types/reachability.ts";
export type { DiffEntry, DiffChanges, DiffObject, DiffObjectKind, DiffObjectMode } from "./diff.ts";
export type { TreeSnapshotEntry } from "./repository/tree/tree-diff.ts";

// ============================================================================
// SHA-1 哈希工具（仅 node:crypto）
// ============================================================================

export { sha1, assertObjectType } from "./types/index.ts";
export { hashData, hashObject, isValidSHA1 } from "./hash/index.ts";

// ============================================================================
// 错误类型（纯定义）
// ============================================================================

export {
  GitError,
  ObjectNotFoundError,
  InvalidObjectError,
  ObjectHashMismatchError,
  InvalidSHA1Error,
  RepositoryError,
  ImportError,
  TreeError,
  MergeError,
  MergeBaseError,
  UnresolvedConflictsError,
  CircularReferenceError,
  RefNotFoundError,
  PackError,
  InvalidPackError,
  PackIndexError,
  DeltaError,
  TransactionError,
  PreconditionCheckError,
  VirtualPathNotFoundError,
  VirtualPathAlreadyExistsError,
  VirtualNotDirectoryError,
  VirtualNotFileError,
  VirtualNotSymlinkError,
  VirtualOriginUnavailableError,
  VirtualWorktreeError,
} from "./errors.ts";
export type {
  GitErrorDetails,
  GitErrorOptions,
  ObjectNotFoundOperation,
  ObjectSourceKind,
  ObjectNotFoundErrorOptions,
  InvalidObjectErrorOptions,
  PackErrorOptions,
  PackIndexErrorOptions,
  DeltaErrorOptions,
  TransactionErrorOptions,
  PreconditionCheckErrorOptions,
  ImportErrorOptions,
  TreeErrorOptions,
  MergeErrorOptions,
  MergeBaseErrorOptions,
  UnresolvedConflictsErrorOptions,
  VirtualPathErrorOptions,
  VirtualWorktreeErrorOptions,
} from "./errors.ts";

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
