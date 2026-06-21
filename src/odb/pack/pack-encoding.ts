/**
 * Packfile 编码共享逻辑
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import { hashObject } from "../../core/hash.ts";
import { serializeContent } from "../../objects/index.ts";
import { PACK_SIGNATURE, PACK_VERSION, objectTypeToNumber } from "./constants.ts";
import { crc32Value } from "./crc32.ts";
import { encodeObjectHeader } from "./utils.ts";

import type { GitObject, SHA1 } from "../../core/types.ts";

/**
 * 用于 pack 编码的对象条目
 */
export interface EncodedPackObject {
  type: GitObject["type"];
  hash: SHA1;
  data: Buffer;
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
  packWithoutChecksum: Buffer;
  packChecksum: Buffer;
  packData: Buffer;
  entries: IndexedPackEntry[];
}

/**
 * 将 Git 对象标准化为 pack 编码条目
 *
 * @param obj - Git 对象
 * @returns 编码条目
 *
 * @example
 * ```ts
 * const entry = toEncodedPackObject(obj);
 * ```
 */
export function toEncodedPackObject(obj: GitObject): EncodedPackObject {
  const data = serializeContent(obj);
  return {
    type: obj.type,
    hash: hashObject(obj.type, data),
    data,
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
  const packParts: Buffer[] = [];
  const entries: IndexedPackEntry[] = [];

  packParts.push(createPackHeader(objects.length));

  let currentOffset = packParts[0]!.length;
  for (const object of objects) {
    const typeNum = objectTypeToNumber(object.type);
    const objectHeader = encodeObjectHeader(typeNum, object.data.length);
    const compressed = deflateSync(object.data);
    const objectData = Buffer.concat([objectHeader, compressed]);

    entries.push({
      hash: object.hash,
      offset: currentOffset,
      crc32: crc32Value(objectData),
    });
    packParts.push(objectHeader, compressed);
    currentOffset += objectData.length;
  }

  const packWithoutChecksum = Buffer.concat(packParts);
  const packChecksum = createHash("sha1").update(packWithoutChecksum).digest();
  const packData = Buffer.concat([packWithoutChecksum, packChecksum]);

  return {
    packWithoutChecksum,
    packChecksum,
    packData,
    entries,
  };
}

function createPackHeader(objectCount: number): Buffer {
  const header = Buffer.alloc(12);
  PACK_SIGNATURE.copy(header, 0);
  header.writeUInt32BE(PACK_VERSION, 4);
  header.writeUInt32BE(objectCount, 8);
  return header;
}
