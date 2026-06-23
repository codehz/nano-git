/**
 * Packfile 读取共享类型
 */

import type { ObjectType, SHA1 } from "../core/types.ts";

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
  /** 解压后的原始数据 */
  data: Buffer;
}
