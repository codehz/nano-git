/**
 * 错误类型兼容出口
 *
 * 具体实现已迁移到 `src/core/errors.ts`，
 * 当前文件只保留原有导入路径的兼容层。
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
} from "./core/errors.ts";
