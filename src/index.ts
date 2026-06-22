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
 * - core/: 核心类型、错误与哈希工具
 * - objects/: Git 对象序列化/反序列化
 * - odb/: 对象数据库（loose objects + pack）
 * - refs/: 引用管理（名称校验、解析、存储）
 * - repository/: 高层仓库 API 与后端
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
} from "./core/index.ts";

export { sha1 } from "./core/index.ts";

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
  PackError,
  InvalidPackError,
  PackIndexError,
  DeltaError,
  PreconditionCheckError,
} from "./core/index.ts";

// ============================================================================
// 哈希工具
// ============================================================================

export {
  hashData,
  hashObject,
  hashToPath,
  pathToHash,
  isValidSHA1,
  hashFile,
} from "./core/index.ts";

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
// 对象数据库
// ============================================================================

export {
  createFileObjectStore,
  createMemoryObjectStore,
  type ObjectStore,
  type MemoryObjectStore,
} from "./odb/index.ts";

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
  type PackIndexReader,
  type PackIndexWriter,
  type PackIndexEntry,
  // Packfile 存储
  createPackObjectStore,
  type PackObjectStore,
  // 组合存储
  createCompositeObjectStore,
  CompositeObjectStore,
  // Packfile 构建器
  createPackBuilder,
  type PackBuilder,
  type PackBuildResult,
} from "./odb/index.ts";

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
  normalizeShortRefName,
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
} from "./repository/backend/index.ts";

// ============================================================================
// 仓库 API
// ============================================================================

export {
  createRepository,
  initRepository,
  openRepository,
  createMemoryRepository,
  type Repository,
  // 新 Import Session API（repository 主路径只保留 import session 模型）
  type ImportSource,
  type ImportView,
  type NamedImportView,
  type ImportSession,
  type ImportPlanBuilder,
  type RefMaterializationBuilder,
  type ImportPreview,
  type ImportApplyResult,
  type RefUpdatePolicy,
  type PlannedRemoteRef,
  type LocalPrecondition,
  type PlannedRefOperation,
  type PlannedRefDeletion,
  type PlannedHeadOperation,
  type ImportDiagnostic,
  type NamespaceMaterializationOptions,
  type BranchMaterializationOptions,
  type TagMaterializationOptions,
  type HeadMaterializationOptions,
  type RepoImportOperations,
  type RepositoryPushOptions,
  type RepositoryPushResult,
} from "./repository/index.ts";

// ============================================================================
// Transport / Plumbing 低层 API
//
// 注意：如果只需要高层仓库操作，请使用 repository 模块。
// 以下为底层协议实现，适用于需要直接操作传输协议的场景。
// ============================================================================

// --- 传输层类型 ---

export type {
  RemoteRef,
  RefAdvertisement,
  PushOptions,
  PushRefUpdate,
  GitServiceTransport,
  UploadPackTransport,
  ReceivePackTransport,
  ParsedRefSpec,
  PktLine,
  PktLineData,
  PktLineFlush,
  PktLineDelimiter,
  PktLineResponseEnd,
  ReceivePackCommand,
  AdvertiseOptions,
  RefMappingRule,
  MatchedRefItem, // 完整匹配结果；注意 matchedItems ≠ refUpdates，wants 可非空但 refUpdates 为空
  RefUpdatePlanItem,
  FetchPlan,
  FetchPackOptions,
} from "./transport/index.ts";

// --- 传输层函数 ---

export {
  // pkt-line 编解码
  encodePktLine,
  encodeFlushPkt,
  encodeDelimiterPkt,
  encodeResponseEndPkt,
  parsePktLines,
  PktLineError,
  // ref 广告解析
  parseRefAdvertisement,
  RefAdvertisementError,
  // side-band 解复用
  extractPackfile,
  extractProgress,
  SideBandError,
  // 请求生成
  buildUploadPackRequest,
  buildReceivePackRequest,
  // 响应解析
  parseReceivePackResult,
  ReceivePackResultError,
  decodeUploadPackResponse,
  UploadPackResponseError,
  decodeReceivePackResponse,
  ReceivePackResponseError,
  // HTTP 传输
  createUploadPackHttpClient,
  createReceivePackHttpClient,
  SmartHttpError,
  // 广告获取
  advertiseRemote,
  // Ref 规划
  parseRefSpec,
  matchesRefSpec,
  mapRefName,
  getLocalRefs,
  planRefUpdates,
  validateExactRules,
  RefPlanError,
  // Fetch-pack（对象同步）
  fetchPack,
  FetchPackError,
  // Ref 更新
  applyRefUpdates,
  resolveBranchTargetHash,
  isRefNamespaceRequiringFastForward,
  RefUpdateError,
  // push 编排
  push,
  PushError,
} from "./transport/index.ts";

// --- 内部传输 Result 类型（仅在需要详细传输结果时导入） ---
// FetchPackResult, ApplyRefUpdatesResult, PushResult
// 推荐优先使用 repository 层的结果类型（ImportApplyResult, RepositoryPushResult）
