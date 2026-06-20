/**
 * 哈希工具兼容出口
 *
 * 具体实现已迁移到 `src/core/hash.ts`，
 * 当前文件只保留原有导入路径的兼容层。
 */

export {
  hashData,
  hashObject,
  hashToPath,
  pathToHash,
  isValidSHA1,
  hashFile,
} from "./core/hash.ts";
