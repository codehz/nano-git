/**
 * nano-git 错误类型体系
 *
 * 提供统一的错误类型，便于错误处理和调试。
 * 所有错误都继承自 GitError 基类。
 *
 * 约定：
 * - 固定字段（hash/ref/path/offset 等）作为 class 属性，类型安全
 * - `details` 仅放临时/低频/调试用扩展键，不替代固定字段
 * - `cause` 走原生 Error options；catch 再抛必须传 cause
 * - message 前缀由子类构造，保留可读性
 */

// ============================================================================
// 公共 options / 类型
// ============================================================================

/**
 * 错误附加细节（低频/调试扩展键）
 *
 * 已知语义应优先使用各错误类的固定字段，而不是塞进 details。
 */
export type GitErrorDetails = Readonly<Record<string, unknown>>;

/**
 * GitError 及子类共用的构造选项
 */
export interface GitErrorOptions {
  /** 原生 Error cause 链，包装底层错误时必须传入 */
  readonly cause?: unknown;
  /** 低频/调试扩展细节，不替代固定字段 */
  readonly details?: GitErrorDetails;
}

/** 对象查找失败时的操作上下文 */
export type ObjectNotFoundOperation = "read" | "delta-base" | "graph-walk" | "ingest";

/** 对象存储来源 */
export type ObjectSourceKind = "loose" | "pack" | "sqlite" | "memory" | "composite";

/**
 * ObjectNotFoundError 构造选项
 */
export interface ObjectNotFoundErrorOptions extends GitErrorOptions {
  /** 覆盖默认 message */
  readonly message?: string;
  /** 触发查找的操作 */
  readonly operation?: ObjectNotFoundOperation;
  /** 对象来源存储 */
  readonly source?: ObjectSourceKind;
}

/**
 * InvalidObjectError 构造选项
 */
export interface InvalidObjectErrorOptions extends GitErrorOptions {
  /** 对象类型（若已知） */
  readonly type?: string;
  /** 对象哈希（若已知） */
  readonly hash?: string;
}

/**
 * InvalidSHA1Error 构造选项
 */
export interface InvalidSHA1ErrorOptions extends GitErrorOptions {
  readonly message?: string;
}

/**
 * CircularReferenceError 构造选项
 */
export interface CircularReferenceErrorOptions extends GitErrorOptions {
  readonly message?: string;
  /** 形成循环的引用链（若可得） */
  readonly chain?: readonly string[];
}

/**
 * RefNotFoundError 构造选项
 */
export interface RefNotFoundErrorOptions extends GitErrorOptions {
  readonly message?: string;
}

/**
 * Pack 相关错误共用选项
 */
export interface PackErrorOptions extends GitErrorOptions {
  /** pack 内字节偏移 */
  readonly offset?: number;
  /** pack 文件路径（若可得） */
  readonly packPath?: string;
}

/**
 * PackIndexError 构造选项
 */
export interface PackIndexErrorOptions extends GitErrorOptions {
  /** 索引文件路径 */
  readonly path?: string;
  /** 文件内偏移 */
  readonly offset?: number;
}

/**
 * DeltaError 构造选项
 */
export interface DeltaErrorOptions extends GitErrorOptions {
  readonly baseLength?: number;
  readonly copyOffset?: number;
  readonly copySize?: number;
  readonly destSize?: number;
  readonly destOffset?: number;
}

/**
 * TransactionError 构造选项
 */
export interface TransactionErrorOptions extends GitErrorOptions {
  /** 触发错误的事务操作 */
  readonly operation?: "commit" | "rollback" | "write" | "delete" | "begin";
}

/**
 * PreconditionCheckError 构造选项
 */
export interface PreconditionCheckErrorOptions extends GitErrorOptions {
  readonly refName?: string;
  readonly expected?: string | null;
  readonly actual?: string | null;
  readonly namespacePattern?: string;
}

/**
 * ImportError 构造选项
 */
export interface ImportErrorOptions extends GitErrorOptions {
  /** import 所处阶段 */
  readonly phase?: "prepare" | "apply";
}

/**
 * TreeError 构造选项
 */
export interface TreeErrorOptions extends GitErrorOptions {
  readonly path?: string;
  readonly hash?: string;
}

/**
 * MergeError 构造选项
 */
export interface MergeErrorOptions extends GitErrorOptions {
  /** 相关路径 */
  readonly path?: string;
  /** 相关对象哈希 */
  readonly hash?: string;
}

/**
 * MergeBaseError 构造选项
 */
export interface MergeBaseErrorOptions extends MergeErrorOptions {
  /** 找到的多个 merge base */
  readonly bases?: readonly string[];
}

/**
 * UnresolvedConflictsError 构造选项
 */
export interface UnresolvedConflictsErrorOptions extends MergeErrorOptions {
  /** 尚未决议的冲突路径 */
  readonly paths?: readonly string[];
}

/**
 * Virtual 路径类错误共用选项
 */
export interface VirtualPathErrorOptions extends GitErrorOptions {
  readonly message?: string;
}

/**
 * VirtualWorktreeError 构造选项
 */
export interface VirtualWorktreeErrorOptions extends GitErrorOptions {
  /** worktree 标识（目录路径或 sqlite key） */
  readonly worktreeKey?: string;
  /** 相关路径 */
  readonly path?: string;
}

// ============================================================================
// 基类
// ============================================================================

/**
 * Git 错误基类
 *
 * 所有 nano-git 抛出的错误都继承自此类。
 *
 * @example
 * ```ts
 * try {
 *   // ...
 * } catch (err) {
 *   if (err instanceof GitError) {
 *     console.error(err.name, err.message, err.details, err.cause);
 *   }
 * }
 * ```
 */
export class GitError extends Error {
  /** 低频/调试扩展细节 */
  readonly details?: GitErrorDetails;

  constructor(message: string, options?: GitErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "GitError";
    this.details = options?.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ============================================================================
// 对象 / 哈希
// ============================================================================

/**
 * 对象未找到错误
 *
 * 当尝试读取不存在的 Git 对象时抛出。
 *
 * @example
 * ```ts
 * throw new ObjectNotFoundError(hash, { operation: "read", source: "loose" });
 * ```
 */
export class ObjectNotFoundError extends GitError {
  /** 缺失对象的哈希 */
  readonly hash: string;
  /** 触发查找的操作 */
  readonly operation?: ObjectNotFoundOperation;
  /** 对象来源存储 */
  readonly source?: ObjectSourceKind;

  constructor(hash: string, options?: ObjectNotFoundErrorOptions) {
    super(options?.message ?? `Object not found: ${hash}`, options);
    this.name = "ObjectNotFoundError";
    this.hash = hash;
    this.operation = options?.operation;
    this.source = options?.source;
  }
}

/**
 * 无效的 Git 对象错误
 *
 * 当对象格式不符合 Git 规范时抛出。
 *
 * @example
 * ```ts
 * throw new InvalidObjectError("missing null byte", { type: "commit" });
 * ```
 */
export class InvalidObjectError extends GitError {
  /** 对象类型（若已知） */
  readonly type?: string;
  /** 对象哈希（若已知） */
  readonly hash?: string;

  constructor(message: string, options?: InvalidObjectErrorOptions) {
    super(`Invalid Git object: ${message}`, options);
    this.name = "InvalidObjectError";
    this.type = options?.type;
    this.hash = options?.hash;
  }
}

/**
 * 对象哈希不匹配错误
 *
 * 当 RawGitObject 声明的 hash 与内容计算出的 hash 不一致时抛出。
 *
 * @example
 * ```ts
 * throw new ObjectHashMismatchError(expected, actual);
 * ```
 */
export class ObjectHashMismatchError extends GitError {
  /** 根据内容计算出的期望哈希 */
  readonly expected: string;
  /** 对象声明的实际哈希 */
  readonly actual: string;

  constructor(
    expected: string,
    actual: string,
    options?: GitErrorOptions & { readonly message?: string },
  ) {
    super(
      options?.message ?? `RawGitObject hash mismatch: expected ${expected}, got ${actual}`,
      options,
    );
    this.name = "ObjectHashMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * 无效的 SHA-1 哈希错误
 *
 * 当字符串不符合 SHA-1 格式（40 个十六进制字符）时抛出。
 *
 * @example
 * ```ts
 * throw new InvalidSHA1Error("abc");
 * ```
 */
export class InvalidSHA1Error extends GitError {
  /** 无效的 SHA-1 字符串 */
  readonly value: string;

  constructor(value: string, options?: InvalidSHA1ErrorOptions) {
    super(options?.message ?? `Invalid SHA-1 hash: ${value}`, options);
    this.name = "InvalidSHA1Error";
    this.value = value;
  }
}

// ============================================================================
// 仓库 / 引用
// ============================================================================

/**
 * 仓库错误
 *
 * 与仓库操作相关的错误。
 *
 * @example
 * ```ts
 * throw new RepositoryError("Backend does not support packfile writes");
 * ```
 */
export class RepositoryError extends GitError {
  constructor(message: string, options?: GitErrorOptions) {
    super(message, options);
    this.name = "RepositoryError";
  }
}

/**
 * 导入计划错误
 *
 * import session 在 prepare / apply 阶段的参数校验与计划执行失败。
 *
 * @example
 * ```ts
 * throw new ImportError("depth 与 deepen 不能同时指定。", { phase: "prepare" });
 * ```
 */
export class ImportError extends RepositoryError {
  /** import 所处阶段 */
  readonly phase?: "prepare" | "apply";

  constructor(message: string, options?: ImportErrorOptions) {
    super(message, options);
    this.name = "ImportError";
    this.phase = options?.phase;
  }
}

/**
 * 树操作错误
 *
 * tree-diff / tree-patch 等路径与 mode 相关失败。
 *
 * @example
 * ```ts
 * throw new TreeError("Path must not be empty", { path: "" });
 * ```
 */
export class TreeError extends RepositoryError {
  /** 相关路径 */
  readonly path?: string;
  /** 相关对象哈希 */
  readonly hash?: string;

  constructor(message: string, options?: TreeErrorOptions) {
    super(message, options);
    this.name = "TreeError";
    this.path = options?.path;
    this.hash = options?.hash;
  }
}

/**
 * 合并操作错误
 *
 * merge-base / 三方合并 / 交互会话相关失败。
 *
 * @example
 * ```ts
 * throw new MergeError("Expected commit object", { hash });
 * ```
 */
export class MergeError extends RepositoryError {
  /** 相关路径 */
  readonly path?: string;
  /** 相关对象哈希 */
  readonly hash?: string;

  constructor(message: string, options?: MergeErrorOptions) {
    super(message, options);
    this.name = "MergeError";
    this.path = options?.path;
    this.hash = options?.hash;
  }
}

/**
 * merge-base 计算错误
 *
 * 多 base、非 commit 输入等 merge-base 阶段失败。
 *
 * @example
 * ```ts
 * throw new MergeBaseError("Multiple merge bases found", { bases });
 * ```
 */
export class MergeBaseError extends MergeError {
  /** 找到的多个 merge base */
  readonly bases?: readonly string[];

  constructor(message: string, options?: MergeBaseErrorOptions) {
    super(message, options);
    this.name = "MergeBaseError";
    this.bases = options?.bases;
  }
}

/**
 * 未决议冲突错误
 *
 * 交互式 merge 在仍有未 resolve 的冲突时调用 finalize 抛出。
 *
 * @example
 * ```ts
 * throw new UnresolvedConflictsError("Unresolved conflicts remain", { paths: ["a.txt"] });
 * ```
 */
export class UnresolvedConflictsError extends MergeError {
  /** 尚未决议的冲突路径 */
  readonly paths: readonly string[];

  constructor(message: string, options?: UnresolvedConflictsErrorOptions) {
    super(message, options);
    this.name = "UnresolvedConflictsError";
    this.paths = options?.paths ?? [];
  }
}

/**
 * 循环引用错误
 *
 * 当检测到符号引用形成循环时抛出。
 *
 * @example
 * ```ts
 * throw new CircularReferenceError("refs/heads/a", { chain: ["a", "b", "a"] });
 * ```
 */
export class CircularReferenceError extends GitError {
  /** 形成循环的引用名称 */
  readonly ref: string;
  /** 形成循环的引用链（若可得） */
  readonly chain?: readonly string[];

  constructor(ref: string, options?: CircularReferenceErrorOptions) {
    super(options?.message ?? `Circular reference detected: ${ref}`, options);
    this.name = "CircularReferenceError";
    this.ref = ref;
    this.chain = options?.chain;
  }
}

/**
 * 引用未找到错误
 *
 * 当尝试读取不存在的引用时抛出。
 *
 * @example
 * ```ts
 * throw new RefNotFoundError("refs/heads/main");
 * ```
 */
export class RefNotFoundError extends GitError {
  /** 不存在的引用名称 */
  readonly ref: string;

  constructor(ref: string, options?: RefNotFoundErrorOptions) {
    super(options?.message ?? `Reference not found: ${ref}`, options);
    this.name = "RefNotFoundError";
    this.ref = ref;
  }
}

/**
 * 事务错误
 *
 * 当事务操作（commit / rollback / write / delete）被非法调用时抛出。
 *
 * @example
 * ```ts
 * throw new TransactionError("Transaction already committed", { operation: "write" });
 * ```
 */
export class TransactionError extends GitError {
  /** 触发错误的事务操作 */
  readonly operation?: "commit" | "rollback" | "write" | "delete" | "begin";

  constructor(message: string, options?: TransactionErrorOptions) {
    super(`Transaction error: ${message}`, options);
    this.name = "TransactionError";
    this.operation = options?.operation;
  }
}

/**
 * 前置条件校验错误
 *
 * 当 import session 在 apply() 阶段检测到 preview() 之后
 * 前置条件（ref 值、期望哈希等）已变化时抛出。
 *
 * @example
 * ```ts
 * throw new PreconditionCheckError("ref mismatch", {
 *   refName: "refs/heads/main",
 *   expected: oldHash,
 *   actual: newHash,
 * });
 * ```
 */
export class PreconditionCheckError extends GitError {
  readonly refName?: string;
  readonly expected?: string | null;
  readonly actual?: string | null;
  readonly namespacePattern?: string;

  constructor(message: string, options?: PreconditionCheckErrorOptions) {
    super(message, options);
    this.name = "PreconditionCheckError";
    this.refName = options?.refName;
    this.expected = options?.expected;
    this.actual = options?.actual;
    this.namespacePattern = options?.namespacePattern;
  }
}

// ============================================================================
// Packfile
// ============================================================================

/**
 * Packfile 错误
 *
 * 与 Packfile 操作相关的错误。
 *
 * @example
 * ```ts
 * throw new PackError("corrupt pack", { offset: 12 });
 * ```
 */
export class PackError extends GitError {
  /** pack 内字节偏移 */
  readonly offset?: number;
  /** pack 文件路径（若可得） */
  readonly packPath?: string;

  constructor(message: string, options?: PackErrorOptions) {
    super(`Packfile error: ${message}`, options);
    this.name = "PackError";
    this.offset = options?.offset;
    this.packPath = options?.packPath;
  }
}

/**
 * 无效的 Packfile 错误
 *
 * 当 Packfile 格式不符合 Git 规范时抛出。
 *
 * @example
 * ```ts
 * throw new InvalidPackError("Checksum mismatch", { offset: 0 });
 * ```
 */
export class InvalidPackError extends PackError {
  constructor(message: string, options?: PackErrorOptions) {
    super(`Invalid packfile: ${message}`, options);
    this.name = "InvalidPackError";
  }
}

/**
 * Packfile 索引错误
 *
 * 当 Packfile 索引（.idx / .midx / bitmap）文件格式不正确时抛出。
 *
 * @example
 * ```ts
 * throw new PackIndexError("Index file too small", { path: idxPath });
 * ```
 */
export class PackIndexError extends PackError {
  /** 索引文件路径 */
  readonly path?: string;

  constructor(message: string, options?: PackIndexErrorOptions) {
    // PackError 会加 "Packfile error:" 前缀；此处再加语义前缀，与历史 message 一致
    super(`Pack index error: ${message}`, options);
    this.name = "PackIndexError";
    this.path = options?.path;
  }
}

/**
 * Delta 解码错误
 *
 * 当 delta 对象解码失败时抛出。
 *
 * @example
 * ```ts
 * throw new DeltaError("Copy out of bounds", {
 *   baseLength: base.length,
 *   copyOffset,
 *   copySize,
 * });
 * ```
 */
export class DeltaError extends PackError {
  readonly baseLength?: number;
  readonly copyOffset?: number;
  readonly copySize?: number;
  readonly destSize?: number;
  readonly destOffset?: number;

  constructor(message: string, options?: DeltaErrorOptions) {
    super(`Delta decode error: ${message}`, options);
    this.name = "DeltaError";
    this.baseLength = options?.baseLength;
    this.copyOffset = options?.copyOffset;
    this.copySize = options?.copySize;
    this.destSize = options?.destSize;
    this.destOffset = options?.destOffset;
  }
}

// ============================================================================
// Virtual Worktree
// ============================================================================

/**
 * 虚拟路径未找到错误
 *
 * 当操作的路径在 session 中不存在时抛出。
 *
 * @example
 * ```ts
 * throw new VirtualPathNotFoundError("src/main.ts");
 * ```
 */
export class VirtualPathNotFoundError extends GitError {
  /** 不存在的路径 */
  readonly path: string;

  constructor(path: string, options?: VirtualPathErrorOptions) {
    super(options?.message ?? `Virtual path not found: ${path}`, options);
    this.name = "VirtualPathNotFoundError";
    this.path = path;
  }
}

/**
 * 虚拟路径已存在错误
 *
 * 当创建的路径已在 session 中存在时抛出。
 *
 * @example
 * ```ts
 * throw new VirtualPathAlreadyExistsError("src/main.ts");
 * ```
 */
export class VirtualPathAlreadyExistsError extends GitError {
  /** 已存在的路径 */
  readonly path: string;

  constructor(path: string, options?: VirtualPathErrorOptions) {
    super(options?.message ?? `Virtual path already exists: ${path}`, options);
    this.name = "VirtualPathAlreadyExistsError";
    this.path = path;
  }
}

/**
 * 非目录错误
 *
 * 当期望路径为目录但实际不是时抛出。
 *
 * @example
 * ```ts
 * throw new VirtualNotDirectoryError("src/main.ts");
 * ```
 */
export class VirtualNotDirectoryError extends GitError {
  /** 路径 */
  readonly path: string;

  constructor(path: string, options?: VirtualPathErrorOptions) {
    super(options?.message ?? `Virtual path is not a directory: ${path}`, options);
    this.name = "VirtualNotDirectoryError";
    this.path = path;
  }
}

/**
 * 非文件错误
 *
 * 当期望路径为文件但实际不是时抛出。
 *
 * @example
 * ```ts
 * throw new VirtualNotFileError("src");
 * ```
 */
export class VirtualNotFileError extends GitError {
  /** 路径 */
  readonly path: string;

  constructor(path: string, options?: VirtualPathErrorOptions) {
    super(options?.message ?? `Virtual path is not a file: ${path}`, options);
    this.name = "VirtualNotFileError";
    this.path = path;
  }
}

/**
 * 非符号链接错误
 *
 * 当期望路径为符号链接但实际不是时抛出。
 *
 * @example
 * ```ts
 * throw new VirtualNotSymlinkError("src/main.ts");
 * ```
 */
export class VirtualNotSymlinkError extends GitError {
  /** 路径 */
  readonly path: string;

  constructor(path: string, options?: VirtualPathErrorOptions) {
    super(options?.message ?? `Virtual path is not a symlink: ${path}`, options);
    this.name = "VirtualNotSymlinkError";
    this.path = path;
  }
}

/**
 * 虚拟工作目录 origin 不可用错误
 *
 * 当操作的路径在 repo 中的 origin 对象缺失时抛出（弱保证场景）。
 *
 * @example
 * ```ts
 * throw new VirtualOriginUnavailableError("src/main.ts");
 * ```
 */
export class VirtualOriginUnavailableError extends GitError {
  /** 路径 */
  readonly path: string;

  constructor(path: string, options?: VirtualPathErrorOptions) {
    super(options?.message ?? `Virtual origin unavailable for: ${path}`, options);
    this.name = "VirtualOriginUnavailableError";
    this.path = path;
  }
}

/**
 * 虚拟工作目录存储/生命周期错误
 *
 * worktree 不存在、已存在、manifest 损坏等存储层失败。
 *
 * @example
 * ```ts
 * throw new VirtualWorktreeError(`Virtual worktree not found: ${key}`, {
 *   worktreeKey: key,
 * });
 * ```
 */
export class VirtualWorktreeError extends GitError {
  /** worktree 标识（目录路径或 sqlite key） */
  readonly worktreeKey?: string;
  /** 相关路径 */
  readonly path?: string;

  constructor(message: string, options?: VirtualWorktreeErrorOptions) {
    super(message, options);
    this.name = "VirtualWorktreeError";
    this.worktreeKey = options?.worktreeKey;
    this.path = options?.path;
  }
}
