/**
 * nano-git - 使用 Node.js 实现的 Git 核心功能
 *
 * 本项目实现了 Git 的基本数据结构和算法，包括：
 * - SHA-1 哈希计算
 * - Git 对象（blob, tree, commit, tag）的序列化/反序列化
 * - 对象存储（文件系统和内存）
 * - 仓库操作 API
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

// 导出类型
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
} from "./types.ts";

// 导出类型辅助函数
export { sha1 } from "./types.ts";

// 导出哈希工具
export {
  hashData,
  hashObject,
  hashToPath,
  pathToHash,
  isValidSHA1,
  hashFile,
} from "./hash.ts";

// 导出序列化/反序列化
export {
  serialize,
  deserialize,
  serializeContent,
  deserializeContent,
} from "./objects.ts";

// 导出对象存储
export {
  createFileObjectStore,
  createMemoryObjectStore,
  type ObjectStore,
} from "./store.ts";

// 导出仓库 API
export {
  initRepository,
  openRepository,
  createMemoryRepository,
  type Repository,
} from "./repository.ts";