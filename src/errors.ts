/**
 * nano-git 错误类型入口
 *
 * 导出所有公共错误类。
 *
 * @example
 * ```ts
 * import { GitError, ObjectNotFoundError } from "nano-git/errors";
 * ```
 */

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
