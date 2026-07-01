/**
 * Multi-Pack Index (MIDX) 共享类型
 *
 * 定义 MIDX 读取器对外暴露的数据结构。
 */

import type { SHA1 } from "../core/types.ts";

/**
 * MIDX 中单个对象的定位条目
 */
export interface MidxEntry {
  /** 对象哈希 */
  hash: SHA1;
  /** pack-int-id（指向 PNAM 中第几个 pack，从 0 起） */
  packId: number;
  /** 对象在对应 packfile 中的偏移 */
  offset: number;
}

/**
 * MIDX 文件头信息
 */
export interface MidxHeader {
  /** MIDX 版本号（1 或 2） */
  version: number;
  /** Object Id Version（1=SHA-1，2=SHA-256） */
  oidVersion: number;
  /** chunk 数量 */
  chunkCount: number;
  /** base multi-pack-index 文件数 */
  baseMidxCount: number;
  /** pack 文件数量 */
  packCount: number;
}

/**
 * MIDX 读取器接口
 */
export interface MidxReader {
  /** MIDX 文件头 */
  readonly header: MidxHeader;

  /** 去重后的对象总数 */
  readonly objectCount: number;

  /**
   * 查找对象条目
   *
   * @param hash - 对象 SHA-1 哈希
   * @returns 条目，不存在则返回 undefined
   */
  lookup(hash: SHA1): MidxEntry | undefined;

  /**
   * 检查对象是否存在
   *
   * @param hash - 对象 SHA-1 哈希
   */
  has(hash: SHA1): boolean;

  /**
   * 获取所有对象哈希列表（去重后）
   */
  listHashes(): SHA1[];

  /**
   * 获取 PNAM 中第 packId 个 pack 的文件名
   *
   * @param packId - pack-int-id
   * @returns pack 文件名（如 `pack-<hash>.pack`）
   */
  getPackName(packId: number): string;
}
