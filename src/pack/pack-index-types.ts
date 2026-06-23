/**
 * Packfile 索引共享类型
 */

import type { SHA1 } from "../core/types.ts";

/**
 * 索引中的对象条目
 */
export interface PackIndexEntry {
  /** 对象的 SHA-1 哈希 */
  hash: SHA1;
  /** 对象在 packfile 中的偏移量 */
  offset: number;
  /** 压缩数据的 CRC32 校验和 */
  crc32: number;
}
