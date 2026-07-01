/**
 * Packfile 读取共享类型
 *
 * PackObject 与 RawGitObject 的关系：
 * - PackObject 包含 offset（packfile 内偏移量），是 pack-specific 的表示
 * - PackObject 的 { type, hash, data } 字段与 RawGitObject 的 { type, hash, content } 语义对齐
 * - 使用 packObjectToRaw() 将 PackObject 转换为 RawGitObject
 */

import type { ObjectType, RawGitObject, SHA1 } from "../../types/index.ts";

/**
 * Packfile 中的对象信息
 */
export interface PackObject {
  /** 对象类型 */
  type: ObjectType;
  /** 对象的 SHA-1 哈希 */
  hash: SHA1;
  /** 对象在 packfile 中的偏移量 */
  offset: number;
  /** 解压后的原始数据（对应 RawGitObject.content） */
  data: Buffer;
}

/**
 * 将 PackObject 转换为 RawGitObject
 *
 * @param packObj - packfile 中的对象
 * @returns 可用于 ODB 的原始对象
 *
 * @example
 * ```ts
 * const raw = packObjectToRaw(packObj);
 * db.ingest(raw);
 * ```
 */
export function packObjectToRaw(packObj: PackObject): RawGitObject {
  return {
    hash: packObj.hash,
    type: packObj.type,
    content: packObj.data,
  };
}
