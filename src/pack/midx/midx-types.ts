/**
 * Multi-Pack Index (MIDX) 共享类型
 *
 * 定义 MIDX 读取器对外暴露的数据结构。
 */

import type { SHA1 } from "../../types/index.ts";

/**
 * MIDX 中单个对象的定位条目
 */
export interface MidxEntry {
  /** 对象哈希 */
  hash: SHA1;
  /** pack-int-id（单文件为 PNAM 下标；增量链为全局 pack-int-id） */
  packId: number;
  /** 对象在对应 packfile 中的偏移 */
  offset: number;
}

/**
 * BTMP chunk 中单个 pack 的 bitmap 区间（pseudo-pack 序）
 */
export interface MidxBitmappedPack {
  /** 在 MIDX bitmap 中的起始位 */
  bitmapPos: number;
  /** 该 pack 在 bitmap 中占用的对象数 */
  bitmapNr: number;
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

  /** 去重后的对象总数（增量链为全局对象数） */
  readonly objectCount: number;

  /**
   * 全局 pack 数量（增量链为各层 pack 之和；单文件等于 header.packCount）
   */
  readonly globalPackCount: number;

  /**
   * 增量链顶 MIDX 文件校验和（单文件经典 MIDX 为文件 trailer OID）
   */
  readonly tipChecksumHex?: string;

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

  /**
   * 获取全局 pack-int-id 对应的 BTMP 区间（无 BTMP chunk 时返回 undefined）
   */
  getBitmappedPack?(globalPackId: number): MidxBitmappedPack | undefined;

  /**
   * 列出所有在 BTMP 中登记的全局 pack-int-id
   */
  listBitmappedGlobalPackIds?(): number[];

  /**
   * RIDX：pseudo-pack 下标 → 全局 MIDX OID 序下标。
   *
   * 长度通常等于 `objectCount`；无 RIDX chunk 时返回 undefined。
   */
  getRevindexPseudoPackOrder?(): readonly number[] | undefined;
}

/**
 * MIDX 读取器构造选项
 */
export interface CreateMidxReaderOptions {
  /**
   * 期望的 OID 版本。
   *
   * 若 MIDX 的 Object Id Version 与此不匹配，应忽略该 MIDX。
   * 在 nano-git 当前仅支持 SHA-1 的场景下固定为 1。
   */
  expectedOidVersion?: number;
}
