/**
 * nano-git 错误类型体系
 *
 * 提供统一的错误类型，便于错误处理和调试。
 * 所有错误都继承自 GitError 基类。
 *
 * 注意：本模块不导入 types.ts，避免循环依赖。
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
    // 确保 instanceof 检查在跨模块时也能正常工作
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 对象未找到错误
 *
 * 当尝试读取不存在的 Git 对象时抛出。
 */
export class ObjectNotFoundError extends GitError {
  constructor(hash: string) {
    super(`Object not found: ${hash}`);
    this.name = "ObjectNotFoundError";
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
  constructor(value: string) {
    super(`Invalid SHA-1 hash: ${value}`);
    this.name = "InvalidSHA1Error";
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
  constructor(ref: string) {
    super(`Circular reference detected: ${ref}`);
    this.name = "CircularReferenceError";
  }
}

/**
 * 引用未找到错误
 *
 * 当尝试读取不存在的引用时抛出。
 */
export class RefNotFoundError extends GitError {
  constructor(ref: string) {
    super(`Reference not found: ${ref}`);
    this.name = "RefNotFoundError";
  }
}
