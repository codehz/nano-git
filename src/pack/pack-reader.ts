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
 */

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import type { GitObject, ObjectType, SHA1 } from "../core/types.ts";
import { hashObject } from "../core/hash.ts";
import { deserializeContent } from "../objects/index.ts";
import { InvalidPackError } from "../core/errors.ts";
import {
  PACK_SIGNATURE,
  PACK_VERSION,
  PACK_HEADER_SIZE,
  PACK_CHECKSUM_SIZE,
  OBJ_OFS_DELTA,
  OBJ_REF_DELTA,
  numberToObjectType,
} from "./constants.ts";
import { decodeObjectHeader, decodeOfsDeltaOffset } from "./utils.ts";
import { applyDelta } from "./delta.ts";

// ============================================================================
// Packfile 对象信息
// ============================================================================

/** Packfile 中的对象信息 */
export interface PackObject {
  /** 对象类型 */
  type: ObjectType;
  /** 对象的 SHA-1 哈希 */
  hash: SHA1;
  /** 对象在 packfile 中的偏移量 */
  offset: number;
  /** 解压后的原始数据 */
  data: Buffer;
}

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
    this._objectCount = this.parseHeader();
  }

  /** 对象数量 */
  get objectCount(): number {
    return this._objectCount;
  }

  /**
   * 解析 packfile 头部
   */
  private parseHeader(): number {
    if (this.data.length < PACK_HEADER_SIZE + PACK_CHECKSUM_SIZE) {
      throw new InvalidPackError("Packfile too small");
    }

    // 验证签名
    const signature = this.data.subarray(0, 4);
    if (!signature.equals(PACK_SIGNATURE)) {
      throw new InvalidPackError(`Invalid signature: ${signature.toString("hex")}`);
    }

    // 验证版本
    const version = this.data.readUInt32BE(4);
    if (version !== PACK_VERSION) {
      throw new InvalidPackError(`Unsupported version: ${version}`);
    }

    // 读取对象数
    const objectCount = this.data.readUInt32BE(8);

    // 验证校验和
    const expectedChecksum = this.data.subarray(this.data.length - PACK_CHECKSUM_SIZE);
    const actualChecksum = createHash("sha1")
      .update(this.data.subarray(0, this.data.length - PACK_CHECKSUM_SIZE))
      .digest();

    if (!expectedChecksum.equals(actualChecksum)) {
      throw new InvalidPackError("Checksum mismatch");
    }

    return objectCount;
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
        // ofs_delta：读取负偏移量
        const [negOffset, offsetBytes] = decodeOfsDeltaOffset(this.data, offset);
        offset += offsetBytes;

        // 读取压缩的 delta 数据
        const [deltaData, compressedBytes] = this.readCompressedData(offset);
        offset += compressedBytes;

        // 查找 base object
        const baseOffset = objOffset - negOffset;
        const baseObj = this.objectsByOffset.get(baseOffset);
        if (!baseObj) {
          throw new InvalidPackError(`Base object not found at offset ${baseOffset}`);
        }

        // 应用 delta
        const resolvedData = applyDelta(baseObj.data, deltaData);
        const hash = hashObject(baseObj.type, resolvedData);

        obj = {
          type: baseObj.type,
          hash,
          offset: objOffset,
          data: resolvedData,
        };
      } else if (typeNum === OBJ_REF_DELTA) {
        // ref_delta：读取 base object 的 SHA-1
        const baseHash = this.data.subarray(offset, offset + 20).toString("hex");
        offset += 20;

        // 读取压缩的 delta 数据
        const [deltaData, compressedBytes] = this.readCompressedData(offset);
        offset += compressedBytes;

        // 查找 base object
        const baseObj = this.objectsByHash.get(baseHash);
        if (!baseObj) {
          throw new InvalidPackError(`Base object not found: ${baseHash}`);
        }

        // 应用 delta
        const resolvedData = applyDelta(baseObj.data, deltaData);
        const hash = hashObject(baseObj.type, resolvedData);

        obj = {
          type: baseObj.type,
          hash,
          offset: objOffset,
          data: resolvedData,
        };
      } else {
        // 非 delta 对象
        const type = numberToObjectType(typeNum);

        // 读取压缩数据
        const [compressedData, compressedBytes] = this.readCompressedData(offset);
        offset += compressedBytes;

        const hash = hashObject(type, compressedData);

        obj = {
          type,
          hash,
          offset: objOffset,
          data: compressedData,
        };
      }

      this.objectsByOffset.set(objOffset, obj);
      this.objectsByHash.set(obj.hash, obj);
    }
  }

  /**
   * 读取 zlib 压缩的数据
   *
   * 使用 zlib 的 `info` 选项获取实际消耗的输入字节数，
   * 从而精确定位下一个对象的起始偏移量。
   */
  private readCompressedData(offset: number): [data: Buffer, bytesRead: number] {
    const remaining = this.data.subarray(offset);

    try {
      const inflated = inflateSync(remaining, {
        info: true,
      }) as unknown;

      if (
        !inflated ||
        typeof inflated !== "object" ||
        !("buffer" in inflated) ||
        !("engine" in inflated)
      ) {
        throw new InvalidPackError("Unexpected inflate result shape");
      }

      const result = inflated as {
        buffer: Uint8Array;
        engine?: { bytesWritten?: number };
      };
      const consumed = result.engine?.bytesWritten;
      if (typeof consumed !== "number" || consumed <= 0) {
        throw new InvalidPackError("Failed to determine compressed stream length");
      }

      return [Buffer.from(result.buffer), consumed];
    } catch (err) {
      throw new InvalidPackError(`Failed to decompress data at offset ${offset}: ${err}`);
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
