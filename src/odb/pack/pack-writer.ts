/**
 * Packfile 写入
 *
 * 将多个 Git 对象打包成一个 packfile。
 *
 * Packfile 格式：
 * - 头部：4 字节签名 "PACK" + 4 字节版本 + 4 字节对象数
 * - 对象序列：每个对象包含头部 + zlib 压缩数据
 * - 尾部：20 字节 SHA-1 校验和（对整个 packfile 的哈希）
 *
 * 当前实现不生成 delta 对象，所有对象都以非 delta 形式存储。
 * 这简化了实现，但牺牲了一些压缩效率。
 *
 * @example
 * ```ts
 * const writer = createPackWriter();
 * writer.addObject({ type: "blob", content: Buffer.from("hello") });
 * const packData = writer.build();
 * ```
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { GitObject, SHA1 } from "../../core/types.ts";
import { hashObject } from "../../core/hash.ts";
import { serializeContent } from "../../objects/index.ts";
import { PACK_SIGNATURE, PACK_VERSION, objectTypeToNumber } from "./constants.ts";
import { encodeObjectHeader } from "./utils.ts";

// ============================================================================
// Packfile 写入器
// ============================================================================

/** 待打包的对象条目 */
interface PackEntry {
  type: GitObject["type"];
  hash: SHA1;
  data: Buffer;
}

/**
 * 创建 Packfile 写入器
 *
 * @returns Packfile 写入器实例
 *
 * @example
 * ```ts
 * const writer = createPackWriter();
 *
 * // 添加对象
 * writer.addObject({ type: "blob", content: Buffer.from("hello") });
 * writer.addObject({ type: "blob", content: Buffer.from("world") });
 *
 * // 构建 packfile
 * const packData = writer.build();
 * ```
 */
export function createPackWriter(): PackWriter {
  return new PackWriter();
}

/**
 * Packfile 写入器类
 */
export class PackWriter {
  private entries: PackEntry[] = [];
  private readonly hashes: Set<SHA1> = new Set();

  /**
   * 添加一个 Git 对象到 packfile
   *
   * @param obj - Git 对象
   * @returns 对象的 SHA-1 哈希
   *
   * @example
   * ```ts
   * const hash = writer.addObject({ type: "blob", content: Buffer.from("hello") });
   * ```
   */
  addObject(obj: GitObject): SHA1 {
    const data = serializeContent(obj);
    const hash = hashObject(obj.type, data);

    if (this.hashes.has(hash)) {
      return hash;
    }

    this.entries.push({
      type: obj.type,
      hash,
      data,
    });
    this.hashes.add(hash);

    return hash;
  }

  /**
   * 获取已添加的对象数量
   */
  get objectCount(): number {
    return this.entries.length;
  }

  /**
   * 构建 packfile 数据
   *
   * @returns 完整的 packfile 二进制数据
   *
   * @example
   * ```ts
   * const packData = writer.build();
   * writeFileSync("objects/pack/pack-xxx.pack", packData);
   * ```
   */
  build(): Buffer {
    const parts: Buffer[] = [];

    // 写入头部
    const header = Buffer.alloc(12);
    PACK_SIGNATURE.copy(header, 0);
    header.writeUInt32BE(PACK_VERSION, 4);
    header.writeUInt32BE(this.entries.length, 8);
    parts.push(header);

    // 写入每个对象
    for (const entry of this.entries) {
      const typeNum = objectTypeToNumber(entry.type);
      const objHeader = encodeObjectHeader(typeNum, entry.data.length);
      const compressed = deflateSync(entry.data);

      parts.push(objHeader, compressed);
    }

    // 计算校验和
    const packWithoutChecksum = Buffer.concat(parts);
    const checksum = createHash("sha1").update(packWithoutChecksum).digest();

    return Buffer.concat([packWithoutChecksum, checksum]);
  }

  /**
   * 获取所有已添加对象的哈希列表
   */
  listHashes(): SHA1[] {
    return this.entries.map((e) => e.hash);
  }
}
