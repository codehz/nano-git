/**
 * Packfile 读取
 *
 * Git Packfile 格式：
 * - 头部：4 字节签名 "PACK" + 4 字节版本 + 4 字节对象数
 * - 对象序列：每个对象包含头部 + zlib 压缩数据
 * - 尾部：20 字节 SHA-1 校验和
 *
 * 对象类型：
 * - 非 delta 对象：直接存储压缩后的对象数据
 * - ofs_delta：基于偏移量的 delta，引用同一 packfile 中的其他对象
 * - ref_delta：基于 SHA-1 的 delta，可引用任意对象
 *
 * @example
 * ```ts
 * const reader = createPackReader(packData);
 * for (const obj of reader.objects()) {
 *   console.log(obj.type, obj.hash);
 * }
 * ```
 *
 * 拆分共享类型与底层辅助函数后，
 * 当前文件只保留对象遍历与 delta 解析主流程。
 */

import type { GitObject, SHA1 } from "../../core/types.ts";
import { deserializeContent } from "../../objects/index.ts";
import { InvalidPackError } from "../../core/errors.ts";
import { PACK_HEADER_SIZE, PACK_CHECKSUM_SIZE, OBJ_OFS_DELTA, OBJ_REF_DELTA } from "./constants.ts";
import { decodeObjectHeader, decodeOfsDeltaOffset } from "./utils.ts";
import type { PackObject } from "./pack-reader-types.ts";
import { parsePackHeader } from "./pack-reader-utils.ts";
import {
  resolveOfsDeltaPackObject,
  resolvePlainPackObject,
  resolveRefDeltaPackObject,
} from "./pack-reader-resolver.ts";

export type { PackObject } from "./pack-reader-types.ts";

// ============================================================================
// Packfile 读取器
// ============================================================================

/**
 * 创建 Packfile 读取器
 *
 * @param data - 完整的 packfile 数据
 * @returns Packfile 读取器实例
 *
 * @example
 * ```ts
 * const reader = createPackReader(packData);
 * console.log(`Packfile 包含 ${reader.objectCount} 个对象`);
 *
 * // 遍历所有对象
 * for (const obj of reader.objects()) {
 *   console.log(`${obj.type} ${obj.hash}`);
 * }
 * ```
 */
export function createPackReader(data: Buffer): PackReader {
  return new PackReader(data);
}

/**
 * Packfile 读取器类
 */
export class PackReader {
  private readonly data: Buffer;
  private readonly _objectCount: number;
  private readonly objectsByOffset: Map<number, PackObject> = new Map();
  private readonly objectsByHash: Map<string, PackObject> = new Map();
  private parsed = false;

  constructor(data: Buffer) {
    this.data = data;
    this._objectCount = parsePackHeader(data);
  }

  /** 对象数量 */
  get objectCount(): number {
    return this._objectCount;
  }

  /**
   * 解析所有对象
   */
  private parseAll(): void {
    if (this.parsed) return;
    this.parsed = true;

    let offset = PACK_HEADER_SIZE;
    const endOffset = this.data.length - PACK_CHECKSUM_SIZE;

    for (let i = 0; i < this._objectCount; i++) {
      if (offset >= endOffset) {
        throw new InvalidPackError(`Unexpected end of packfile at object ${i}`);
      }

      const objOffset = offset;
      const [typeNum, _size, headerBytes] = decodeObjectHeader(this.data, offset);
      offset += headerBytes;

      let obj: PackObject;

      if (typeNum === OBJ_OFS_DELTA) {
        const [negOffset, offsetBytes] = decodeOfsDeltaOffset(this.data, offset);
        offset += offsetBytes;
        const resolved = resolveOfsDeltaPackObject(
          this.data,
          offset,
          objOffset,
          negOffset,
          this.objectsByOffset,
        );
        obj = resolved.object;
        offset = resolved.nextOffset;
      } else if (typeNum === OBJ_REF_DELTA) {
        const baseHash = this.data.subarray(offset, offset + 20).toString("hex");
        offset += 20;
        const resolved = resolveRefDeltaPackObject(
          this.data,
          offset,
          objOffset,
          baseHash,
          this.objectsByHash,
        );
        obj = resolved.object;
        offset = resolved.nextOffset;
      } else {
        const resolved = resolvePlainPackObject(this.data, offset, objOffset, typeNum);
        obj = resolved.object;
        offset = resolved.nextOffset;
      }

      this.objectsByOffset.set(objOffset, obj);
      this.objectsByHash.set(obj.hash, obj);
    }
  }

  /**
   * 遍历所有对象
   */
  *objects(): Generator<PackObject> {
    this.parseAll();
    yield* this.objectsByOffset.values();
  }

  /**
   * 根据哈希获取对象
   */
  getByHash(hash: SHA1): PackObject | undefined {
    this.parseAll();
    return this.objectsByHash.get(hash);
  }

  /**
   * 根据偏移量获取对象
   */
  getByOffset(offset: number): PackObject | undefined {
    this.parseAll();
    return this.objectsByOffset.get(offset);
  }

  /**
   * 检查对象是否存在
   */
  has(hash: SHA1): boolean {
    this.parseAll();
    return this.objectsByHash.has(hash);
  }

  /**
   * 获取 GitObject
   */
  readObject(hash: SHA1): GitObject | undefined {
    const obj = this.getByHash(hash);
    if (!obj) return undefined;

    return deserializeContent(obj.type, obj.data);
  }

  /**
   * 获取所有对象的哈希列表
   */
  listHashes(): SHA1[] {
    this.parseAll();
    return Array.from(this.objectsByHash.keys()) as SHA1[];
  }
}
