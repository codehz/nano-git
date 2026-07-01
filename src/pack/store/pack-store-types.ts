/**
 * Pack 对象存储共享类型
 */

import { PackReader } from "../reader/pack-reader.ts";

import type { PackIndexReader } from "../idx/pack-index.ts";
import type { MidxReader } from "../midx/midx-types.ts";

/**
 * 一个 packfile 及其索引的组合
 */
export interface PackPair {
  /** packfile 的 SHA-1 校验和（文件名中的哈希部分） */
  checksum: string;
  /** 索引读取器 */
  index: PackIndexReader;
  /** packfile 读取器（延迟加载） */
  reader: PackReader | null;
  /** packfile 数据（延迟加载） */
  packData: Buffer | null;
}

/**
 * Pack 目录加载结果
 */
export interface PackStoreLoadResult {
  /** 已发现的 pack 文件对 */
  pairs: PackPair[];
  /** 可选的 MIDX 读取器 */
  midx: MidxReader | null;
}

/**
 * 一个已发现的 pack 文件对
 */
export interface PackFileInfo {
  /** pack 文件校验和 */
  checksum: string;
  /** .pack 文件路径 */
  packPath: string;
  /** .idx 文件路径 */
  idxPath: string;
  /** 索引中的对象数量 */
  objectCount: number;
}
