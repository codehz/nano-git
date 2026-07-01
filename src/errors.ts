/**
 * nano-git 错误类型体系
 *
 * 提供统一的错误类型，便于错误处理和调试。
 * 所有错误都继承自 GitError 基类。
 */

/**
 * Git 错误基类
 *
 * 所有 nano-git 抛出的错误都继承自此类。
 */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 对象未找到错误
 *
 * 当尝试读取不存在的 Git 对象时抛出。
 */
export class ObjectNotFoundError extends GitError {
  /** 缺失对象的哈希 */
  hash: string;

  constructor(hash: string, message?: string) {
    super(message ?? `Object not found: ${hash}`);
    this.name = "ObjectNotFoundError";
    this.hash = hash;
  }
}

/**
 * 无效的 Git 对象错误
 *
 * 当对象格式不符合 Git 规范时抛出。
 */
export class InvalidObjectError extends GitError {
  constructor(message: string) {
    super(`Invalid Git object: ${message}`);
    this.name = "InvalidObjectError";
  }
}

/**
 * 无效的 SHA-1 哈希错误
 *
 * 当字符串不符合 SHA-1 格式（40 个十六进制字符）时抛出。
 */
export class InvalidSHA1Error extends GitError {
  /** 无效的 SHA-1 字符串 */
  value: string;

  constructor(value: string) {
    super(`Invalid SHA-1 hash: ${value}`);
    this.name = "InvalidSHA1Error";
    this.value = value;
  }
}

/**
 * 仓库错误
 *
 * 与仓库操作相关的错误。
 */
export class RepositoryError extends GitError {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryError";
  }
}

/**
 * 循环引用错误
 *
 * 当检测到符号引用形成循环时抛出。
 */
export class CircularReferenceError extends GitError {
  /** 形成循环的引用名称 */
  ref: string;

  constructor(ref: string) {
    super(`Circular reference detected: ${ref}`);
    this.name = "CircularReferenceError";
    this.ref = ref;
  }
}

/**
 * 引用未找到错误
 *
 * 当尝试读取不存在的引用时抛出。
 */
export class RefNotFoundError extends GitError {
  /** 不存在的引用名称 */
  ref: string;

  constructor(ref: string) {
    super(`Reference not found: ${ref}`);
    this.name = "RefNotFoundError";
    this.ref = ref;
  }
}

/**
 * Packfile 错误
 *
 * 与 Packfile 操作相关的错误。
 */
export class PackError extends GitError {
  constructor(message: string) {
    super(`Packfile error: ${message}`);
    this.name = "PackError";
  }
}

/**
 * 无效的 Packfile 错误
 *
 * 当 Packfile 格式不符合 Git 规范时抛出。
 */
export class InvalidPackError extends PackError {
  constructor(message: string) {
    super(`Invalid packfile: ${message}`);
    this.name = "InvalidPackError";
  }
}

/**
 * Packfile 索引错误
 *
 * 当 Packfile 索引（.idx）文件格式不正确时抛出。
 */
export class PackIndexError extends PackError {
  constructor(message: string) {
    super(`Pack index error: ${message}`);
    this.name = "PackIndexError";
  }
}

/**
 * Delta 解码错误
 *
 * 当 delta 对象解码失败时抛出。
 */
export class DeltaError extends PackError {
  constructor(message: string) {
    super(`Delta decode error: ${message}`);
    this.name = "DeltaError";
  }
}

/**
 * 事务错误
 *
 * 当事务操作（commit / rollback / write / delete）被非法调用时抛出。
 */
export class TransactionError extends GitError {
  constructor(message: string) {
    super(`Transaction error: ${message}`);
    this.name = "TransactionError";
  }
}

/**
 * 前置条件校验错误
 *
 * 当 import session 在 apply() 阶段检测到 preview() 之后
 * 前置条件（ref 值、期望哈希等）已变化时抛出。
 */
export class PreconditionCheckError extends GitError {
  constructor(message: string) {
    super(message);
    this.name = "PreconditionCheckError";
  }
}

// ==================== Virtual Worktree（虚拟工作目录）错误类型 ====================

/**
 * 虚拟路径未找到错误
 *
 * 当操作的路径在 session 中不存在时抛出。
 */
export class VirtualPathNotFoundError extends GitError {
  /** 不存在的路径 */
  path: string;

  constructor(path: string, message?: string) {
    super(message ?? `Virtual path not found: ${path}`);
    this.name = "VirtualPathNotFoundError";
    this.path = path;
  }
}

/**
 * 虚拟路径已存在错误
 *
 * 当创建的路径已在 session 中存在时抛出。
 */
export class VirtualPathAlreadyExistsError extends GitError {
  /** 已存在的路径 */
  path: string;

  constructor(path: string, message?: string) {
    super(message ?? `Virtual path already exists: ${path}`);
    this.name = "VirtualPathAlreadyExistsError";
    this.path = path;
  }
}

/**
 * 非目录错误
 *
 * 当期望路径为目录但实际不是时抛出。
 */
export class VirtualNotDirectoryError extends GitError {
  /** 路径 */
  path: string;

  constructor(path: string, message?: string) {
    super(message ?? `Virtual path is not a directory: ${path}`);
    this.name = "VirtualNotDirectoryError";
    this.path = path;
  }
}

/**
 * 非文件错误
 *
 * 当期望路径为文件但实际不是时抛出。
 */
export class VirtualNotFileError extends GitError {
  /** 路径 */
  path: string;

  constructor(path: string, message?: string) {
    super(message ?? `Virtual path is not a file: ${path}`);
    this.name = "VirtualNotFileError";
    this.path = path;
  }
}

/**
 * 非符号链接错误
 *
 * 当期望路径为符号链接但实际不是时抛出。
 */
export class VirtualNotSymlinkError extends GitError {
  /** 路径 */
  path: string;

  constructor(path: string, message?: string) {
    super(message ?? `Virtual path is not a symlink: ${path}`);
    this.name = "VirtualNotSymlinkError";
    this.path = path;
  }
}

/**
 * 虚拟工作目录 origin 不可用错误
 *
 * 当操作的路径在 repo 中的 origin 对象缺失时抛出（弱保证场景）。
 */
export class VirtualOriginUnavailableError extends GitError {
  /** 路径 */
  path: string;

  constructor(path: string, message?: string) {
    super(message ?? `Virtual origin unavailable for: ${path}`);
    this.name = "VirtualOriginUnavailableError";
    this.path = path;
  }
}
