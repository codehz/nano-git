/**
 * Packfile 对象解析辅助函数
 */

import { InvalidPackError } from "../../core/errors.ts";
import { hashObject } from "../../core/hash.ts";
import { numberToObjectType } from "./constants.ts";
import { applyDelta } from "./delta.ts";
import { readCompressedData } from "./pack-reader-utils.ts";

import type { PackObject } from "./pack-reader-types.ts";

/**
 * 解析普通对象
 *
 * @param data - 完整的 packfile 数据
 * @param offset - 压缩数据起始偏移量
 * @param objOffset - 当前对象头起始偏移量
 * @param typeNum - pack 中的对象类型编号
 * @returns 解析结果和新的偏移量
 *
 * @example
 * ```ts
 * const result = resolvePlainPackObject(packData, offset, objOffset, 3);
 * ```
 */
export function resolvePlainPackObject(
  data: Buffer,
  offset: number,
  objOffset: number,
  typeNum: number,
): { object: PackObject; nextOffset: number } {
  const type = numberToObjectType(typeNum);
  const [compressedData, compressedBytes] = readCompressedData(data, offset);
  const nextOffset = offset + compressedBytes;
  const hash = hashObject(type, compressedData);

  return {
    object: {
      type,
      hash,
      offset: objOffset,
      data: compressedData,
    },
    nextOffset,
  };
}

/**
 * 解析基于偏移量的 delta 对象
 *
 * @param data - 完整的 packfile 数据
 * @param offset - delta 数据起始偏移量
 * @param objOffset - 当前对象头起始偏移量
 * @param negOffset - 相对 base object 的负偏移量
 * @param objectsByOffset - 已解析对象缓存
 * @returns 解析结果和新的偏移量
 *
 * @example
 * ```ts
 * const result = resolveOfsDeltaPackObject(data, offset, objOffset, 32, cache);
 * ```
 */
export function resolveOfsDeltaPackObject(
  data: Buffer,
  offset: number,
  objOffset: number,
  negOffset: number,
  objectsByOffset: Map<number, PackObject>,
): { object: PackObject; nextOffset: number } {
  const [deltaData, compressedBytes] = readCompressedData(data, offset);
  const nextOffset = offset + compressedBytes;

  const baseOffset = objOffset - negOffset;
  const baseObj = objectsByOffset.get(baseOffset);
  if (!baseObj) {
    throw new InvalidPackError(`Base object not found at offset ${baseOffset}`);
  }

  const resolvedData = applyDelta(baseObj.data, deltaData);
  const hash = hashObject(baseObj.type, resolvedData);

  return {
    object: {
      type: baseObj.type,
      hash,
      offset: objOffset,
      data: resolvedData,
    },
    nextOffset,
  };
}

/**
 * 解析基于哈希的 delta 对象
 *
 * @param data - 完整的 packfile 数据
 * @param offset - delta 数据起始偏移量
 * @param objOffset - 当前对象头起始偏移量
 * @param baseHash - base object 的 SHA-1 十六进制字符串
 * @param objectsByHash - 已解析对象缓存
 * @returns 解析结果和新的偏移量
 *
 * @example
 * ```ts
 * const result = resolveRefDeltaPackObject(data, offset, objOffset, hash, cache);
 * ```
 */
export function resolveRefDeltaPackObject(
  data: Buffer,
  offset: number,
  objOffset: number,
  baseHash: string,
  objectsByHash: Map<string, PackObject>,
): { object: PackObject; nextOffset: number } {
  const [deltaData, compressedBytes] = readCompressedData(data, offset);
  const nextOffset = offset + compressedBytes;

  const baseObj = objectsByHash.get(baseHash);
  if (!baseObj) {
    throw new InvalidPackError(`Base object not found: ${baseHash}`);
  }

  const resolvedData = applyDelta(baseObj.data, deltaData);
  const hash = hashObject(baseObj.type, resolvedData);

  return {
    object: {
      type: baseObj.type,
      hash,
      offset: objOffset,
      data: resolvedData,
    },
    nextOffset,
  };
}
