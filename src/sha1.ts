/**
 * SHA-1 与对象类型相关工具入口
 *
 * 仅导出纯计算能力，不包含文件系统依赖。
 */

export type { SHA1, ObjectType } from "./core/types.ts";
export { sha1, assertObjectType } from "./core/types.ts";
export { hashData, hashObject, isValidSHA1 } from "./core/hash.ts";
