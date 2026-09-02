/**
 * Packfile 编码共享逻辑
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import { allocBytes, concatBytes, copyBytes, writeU32BE } from "../../bytes.ts";
import { PACK_SIGNATURE, PACK_VERSION, objectTypeToNumber } from "../constants.ts";
import { crc32Value } from "../crc32.ts";
import { encodeObjectHeader } from "../utils/utils.ts";

import type { RawGitObject, SHA1 } from "../../types/index.ts";

/**
 * 用于 pack 编码的对象条目
 */
export interface EncodedPackObject {
  type: RawGitObject["type"];
  hash: SHA1;
  data: Uint8Array;
}

/**
 * 带索引信息的 pack 编码条目
 */
export interface IndexedPackEntry {
  hash: SHA1;
  offset: number;
  crc32: number;
}

/**
 * Pack 编码结果
 */
export interface EncodedPackResult {
  packWithoutChecksum: Uint8Array;
  packChecksum: Uint8Array;
  packData: Uint8Array;
  entries: IndexedPackEntry[];
}

/**
 * 将原始对象标准化为 pack 编码条目
 *
 * RawGitObject 的 { type, hash, content } 直接映射到 EncodedPackObject 的
 * { type, hash, data }，无需额外哈希计算或序列化。
 *
 * @param raw - 原始对象
 * @returns 编码条目
 *
 * @example
 * ```ts
 * const entry = toEncodedPackObject(raw);
 * ```
 */
export function toEncodedPackObject(raw: RawGitObject): EncodedPackObject {
  return {
    type: raw.type,
    hash: raw.hash,
    data: raw.content,
  };
}

/**
 * 构建 packfile 二进制内容，并返回索引所需元数据
 *
 * @param objects - 已标准化的编码条目
 * @returns pack 数据和索引条目
 *
 * @example
 * ```ts
 * const result = buildEncodedPack(entries);
 * ```
 */
export function buildEncodedPack(objects: EncodedPackObject[]): EncodedPackResult {
  const packParts: Uint8Array[] = [];
  const entries: IndexedPackEntry[] = [];

  packParts.push(createPackHeader(objects.length));

  let currentOffset = packParts[0]!.length;
  for (const object of objects) {
    const typeNum = objectTypeToNumber(object.type);
    const objectHeader = encodeObjectHeader(typeNum, object.data.length);
    const compressed = deflateSync(object.data);
    const objectData = concatBytes(objectHeader, compressed);

    entries.push({
      hash: object.hash,
      offset: currentOffset,
      crc32: crc32Value(objectData),
    });
    packParts.push(objectHeader, compressed);
    currentOffset += objectData.length;
  }

  const packWithoutChecksum = concatBytes(...packParts);
  const packChecksum = createHash("sha1").update(packWithoutChecksum).digest();
  const packData = concatBytes(packWithoutChecksum, packChecksum);

  return {
    packWithoutChecksum,
    packChecksum,
    packData,
    entries,
  };
}

function createPackHeader(objectCount: number): Uint8Array {
  const header = allocBytes(12);
  copyBytes(header, 0, PACK_SIGNATURE);
  writeU32BE(header, 4, PACK_VERSION);
  writeU32BE(header, 8, objectCount);
  return header;
}
