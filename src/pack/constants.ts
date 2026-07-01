/**
 * Packfile 常量和类型编码
 *
 * Git Packfile 格式中的对象类型编码和协议常量。
 *
 * Packfile 对象类型：
 * - 1: commit
 * - 2: tree
 * - 3: blob
 * - 4: tag
 * - 6: ofs_delta（基于偏移量的 delta）
 * - 7: ref_delta（基于引用的 delta）
 */

import type { ObjectType } from "../types/index.ts";

// ============================================================================
// Packfile 对象类型编码
// ============================================================================

/** Packfile 中的对象类型编号 */
export const OBJ_COMMIT = 1;
export const OBJ_TREE = 2;
export const OBJ_BLOB = 3;
export const OBJ_TAG = 4;
export const OBJ_OFS_DELTA = 6;
export const OBJ_REF_DELTA = 7;

/** Packfile 魔数 "PACK" */
export const PACK_SIGNATURE = Buffer.from("PACK");

/** Packfile 版本号（当前支持 v2） */
export const PACK_VERSION = 2;

/** Packfile 头部长度：4 字节签名 + 4 字节版本 + 4 字节对象数 = 12 */
export const PACK_HEADER_SIZE = 12;

/** Packfile 尾部 SHA-1 校验和长度 */
export const PACK_CHECKSUM_SIZE = 20;

/** idx v2 文件魔数 */
export const IDX_V2_SIGNATURE = Buffer.from([0xff, 0x74, 0x4f, 0x63]);

/** idx v2 版本号 */
export const IDX_V2_VERSION = 2;

/** idx v2 头部大小：4 字节魔数 + 4 字节版本 = 8 */
export const IDX_V2_HEADER_SIZE = 8;

/** idx v2 扇出表大小：256 个 4 字节整数 */
export const IDX_V2_FANOUT_SIZE = 256 * 4;

// ============================================================================
// 类型编码转换
// ============================================================================

/**
 * 将 Git 对象类型字符串转换为 Packfile 类型编号
 *
 * @example
 * ```ts
 * objectTypeToNumber("commit") // => 1
 * objectTypeToNumber("blob")   // => 3
 * ```
 */
export function objectTypeToNumber(type: ObjectType): number {
  switch (type) {
    case "commit":
      return OBJ_COMMIT;
    case "tree":
      return OBJ_TREE;
    case "blob":
      return OBJ_BLOB;
    case "tag":
      return OBJ_TAG;
  }
}

/**
 * 将 Packfile 类型编号转换为 Git 对象类型字符串
 *
 * @example
 * ```ts
 * numberToObjectType(1) // => "commit"
 * numberToObjectType(3) // => "blob"
 * ```
 */
export function numberToObjectType(n: number): ObjectType {
  switch (n) {
    case OBJ_COMMIT:
      return "commit";
    case OBJ_TREE:
      return "tree";
    case OBJ_BLOB:
      return "blob";
    case OBJ_TAG:
      return "tag";
    default:
      throw new Error(`Unknown object type number: ${n}`);
  }
}

/**
 * 判断类型编号是否为 delta 类型
 */
export function isDeltaType(typeNum: number): boolean {
  return typeNum === OBJ_OFS_DELTA || typeNum === OBJ_REF_DELTA;
}
