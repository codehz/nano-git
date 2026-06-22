/**
 * Pack 对象存储共享类型
 */

import { PackReader } from "./pack-reader.ts";

import type { PackIndexReader } from "./pack-index.ts";

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
