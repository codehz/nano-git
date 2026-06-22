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

import { InvalidPackError } from "../../core/errors.ts";
import { deserializeContent } from "../../objects/index.ts";
import { PACK_HEADER_SIZE, PACK_CHECKSUM_SIZE, OBJ_OFS_DELTA, OBJ_REF_DELTA } from "./constants.ts";
import {
  resolveOfsDeltaPackObject,
  resolvePlainPackObject,
  resolveRefDeltaPackObject,
} from "./pack-reader-resolver.ts";
import { parsePackHeader } from "./pack-reader-utils.ts";
import { decodeObjectHeader, decodeOfsDeltaOffset } from "./utils.ts";

import type { GitObject, SHA1 } from "../../core/types.ts";
import type { PackObject } from "./pack-reader-types.ts";

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
 *
 * 使用惰性解析策略：对象在首次被访问时才解析。
 * - getByHash() / getByOffset() / has() 只解析到找到目标为止
 * - objects() / listHashes() 解析全部对象
 */
export class PackReader {
  private readonly data: Buffer;
  private readonly _objectCount: number;
  private readonly objectsByOffset: Map<number, PackObject> = new Map();
  private readonly objectsByHash: Map<string, PackObject> = new Map();
  private parseOffset: number;
  private parsedCount = 0;
  private fullyParsed = false;

  constructor(data: Buffer) {
    this.data = data;
    this._objectCount = parsePackHeader(data);
    this.parseOffset = PACK_HEADER_SIZE;
  }

  /** 对象数量 */
  get objectCount(): number {
    return this._objectCount;
  }

  /**
   * 解析下一个对象
   */
  private parseNext(): void {
    if (this.fullyParsed) return;

    const endOffset = this.data.length - PACK_CHECKSUM_SIZE;

    if (this.parsedCount >= this._objectCount || this.parseOffset >= endOffset) {
      this.fullyParsed = true;
      if (this.parsedCount < this._objectCount) {
        throw new InvalidPackError(`Unexpected end of packfile at object ${this.parsedCount}`);
      }
      return;
    }

    const objOffset = this.parseOffset;
    const [typeNum, _size, headerBytes] = decodeObjectHeader(this.data, this.parseOffset);
    this.parseOffset += headerBytes;

    let obj: PackObject;

    if (typeNum === OBJ_OFS_DELTA) {
      const [negOffset, offsetBytes] = decodeOfsDeltaOffset(this.data, this.parseOffset);
      this.parseOffset += offsetBytes;
      const resolved = resolveOfsDeltaPackObject(
        this.data,
        this.parseOffset,
        objOffset,
        negOffset,
        this.objectsByOffset,
      );
      obj = resolved.object;
      this.parseOffset = resolved.nextOffset;
    } else if (typeNum === OBJ_REF_DELTA) {
      const baseHash = this.data.subarray(this.parseOffset, this.parseOffset + 20).toString("hex");
      this.parseOffset += 20;
      const resolved = resolveRefDeltaPackObject(
        this.data,
        this.parseOffset,
        objOffset,
        baseHash,
        this.objectsByHash,
      );
      obj = resolved.object;
      this.parseOffset = resolved.nextOffset;
    } else {
      const resolved = resolvePlainPackObject(this.data, this.parseOffset, objOffset, typeNum);
      obj = resolved.object;
      this.parseOffset = resolved.nextOffset;
    }

    this.objectsByOffset.set(objOffset, obj);
    this.objectsByHash.set(obj.hash, obj);
    this.parsedCount++;

    if (this.parsedCount >= this._objectCount) {
      this.fullyParsed = true;
    }
  }

  /**
   * 按需解析直到条件满足或解析全部
   */
  private parseUntil(condition: () => boolean): void {
    while (!this.fullyParsed && !condition()) {
      this.parseNext();
    }
  }

  /**
   * 解析所有剩余对象
   */
  private parseAllRemaining(): void {
    this.parseUntil(() => this.fullyParsed);
  }

  /**
   * 遍历所有对象
   *
   * 按 offset 顺序解析并迭代所有对象。
   */
  *objects(): Generator<PackObject> {
    this.parseAllRemaining();
    yield* this.objectsByOffset.values();
  }

  /**
   * 根据哈希获取对象（惰性解析）
   *
   * 只解析到找到目标对象为止，不解析全部。
   */
  getByHash(hash: SHA1): PackObject | undefined {
    if (this.objectsByHash.has(hash)) return this.objectsByHash.get(hash);
    this.parseUntil(() => this.objectsByHash.has(hash));
    return this.objectsByHash.get(hash);
  }

  /**
   * 根据偏移量获取对象（惰性解析）
   *
   * 只解析到目标偏移位置为止。
   */
  getByOffset(offset: number): PackObject | undefined {
    if (this.objectsByOffset.has(offset)) return this.objectsByOffset.get(offset);
    this.parseUntil(() => this.objectsByOffset.has(offset) || this.fullyParsed);
    return this.objectsByOffset.get(offset);
  }

  /**
   * 检查对象是否存在（惰性查找）
   */
  has(hash: SHA1): boolean {
    if (this.objectsByHash.has(hash)) return true;
    this.parseUntil(() => this.objectsByHash.has(hash));
    return this.objectsByHash.has(hash);
  }

  /**
   * 获取 GitObject（惰性查找）
   */
  readObject(hash: SHA1): GitObject | undefined {
    const obj = this.getByHash(hash);
    if (!obj) return undefined;

    return deserializeContent(obj.type, obj.data);
  }

  /**
   * 获取所有对象的哈希列表（解析全部）
   */
  listHashes(): SHA1[] {
    this.parseAllRemaining();
    return Array.from(this.objectsByHash.keys()) as SHA1[];
  }
}
