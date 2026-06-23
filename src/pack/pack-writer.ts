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

import { buildEncodedPack, type EncodedPackObject, toEncodedPackObject } from "./pack-encoding.ts";

import type { RawGitObject, SHA1 } from "../core/types.ts";

// ============================================================================
// Packfile 写入器
// ============================================================================

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
  private entries: EncodedPackObject[] = [];
  private readonly hashes: Set<SHA1> = new Set();

  /**
   * 添加一个原始对象到 packfile
   *
   * @param raw - 原始 Git 对象
   * @returns 对象的 SHA-1 哈希
   *
   * @example
   * ```ts
   * const hash = writer.addRaw(raw);
   * ```
   */
  addRaw(raw: RawGitObject): SHA1 {
    const entry = toEncodedPackObject(raw);
    const hash = entry.hash;

    if (this.hashes.has(hash)) {
      return hash;
    }

    this.entries.push(entry);
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
    return buildEncodedPack(this.entries).packData;
  }

  /**
   * 获取所有已添加对象的哈希列表
   */
  listHashes(): SHA1[] {
    return this.entries.map((e) => e.hash);
  }
}
