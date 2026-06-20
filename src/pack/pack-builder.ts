/**
 * Packfile 构建器
 *
 * 将 loose objects 打包成新的 packfile 和索引文件，
 * 并写入到 .git/objects/pack/ 目录。
 *
 * 这是 `git repack` 和 `git gc` 的核心功能。
 *
 * @example
 * ```ts
 * const builder = createPackBuilder(gitDir);
 * builder.addObject(blob);
 * builder.addObject(commit);
 * const result = builder.build();
 * // result => { packPath, idxPath, checksum, objectCount }
 * ```
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { GitObject, SHA1 } from "../core/types.ts";
import { hashObject } from "../core/hash.ts";
import { serializeContent } from "../objects/index.ts";
import { PackIndexWriter } from "./pack-index.ts";
import { PACK_SIGNATURE, PACK_VERSION, objectTypeToNumber } from "./constants.ts";
import { encodeObjectHeader } from "./utils.ts";

// ============================================================================
// 构建结果
// ============================================================================

/** Packfile 构建结果 */
export interface PackBuildResult {
  /** packfile 文件路径 */
  packPath: string;
  /** 索引文件路径 */
  idxPath: string;
  /** packfile 的 SHA-1 校验和 */
  checksum: string;
  /** 打包的对象数量 */
  objectCount: number;
}

// ============================================================================
// Packfile 构建器
// ============================================================================

/**
 * 创建 Packfile 构建器
 *
 * @param gitDir - .git 目录的路径
 * @returns Packfile 构建器实例
 *
 * @example
 * ```ts
 * const builder = createPackBuilder("/path/to/.git");
 *
 * // 添加对象
 * builder.addObject({ type: "blob", content: Buffer.from("hello") });
 * builder.addObject({ type: "blob", content: Buffer.from("world") });
 *
 * // 构建并写入
 * const result = builder.build();
 * console.log(`已打包 ${result.objectCount} 个对象到 ${result.packPath}`);
 * ```
 */
export function createPackBuilder(gitDir: string): PackBuilder {
  return new PackBuilder(gitDir);
}

/**
 * Packfile 构建器类
 */
export class PackBuilder {
  private readonly gitDir: string;
  private readonly objects: GitObject[] = [];
  private readonly hashes: Set<SHA1> = new Set();

  constructor(gitDir: string) {
    this.gitDir = gitDir;
  }

  /**
   * 添加一个 Git 对象
   *
   * @param obj - Git 对象
   * @returns 对象的 SHA-1 哈希
   */
  addObject(obj: GitObject): SHA1 {
    const data = serializeContent(obj);
    const hash = hashObject(obj.type, data);

    if (this.hashes.has(hash)) {
      return hash;
    }

    this.objects.push(obj);
    this.hashes.add(hash);
    return hash;
  }

  /**
   * 获取已添加的对象数量
   */
  get objectCount(): number {
    return this.objects.length;
  }

  /**
   * 构建 packfile 和索引文件
   *
   * @returns 构建结果，包含文件路径和校验和
   *
   * @example
   * ```ts
   * const result = builder.build();
   * console.log(`Packfile: ${result.packPath}`);
   * console.log(`Index: ${result.idxPath}`);
   * ```
   */
  build(): PackBuildResult {
    const packDir = join(this.gitDir, "objects", "pack");
    mkdirSync(packDir, { recursive: true });

    // 构建 packfile 数据，同时记录每个对象的偏移量和 CRC32
    const packParts: Buffer[] = [];
    const entries: Array<{ hash: SHA1; offset: number; crc32: number }> = [];

    // 写入头部
    const header = Buffer.alloc(12);
    PACK_SIGNATURE.copy(header, 0);
    header.writeUInt32BE(PACK_VERSION, 4);
    header.writeUInt32BE(this.objects.length, 8);
    packParts.push(header);

    // 写入每个对象
    for (const obj of this.objects) {
      const data = serializeContent(obj);
      const hash = hashObject(obj.type, data);
      const typeNum = objectTypeToNumber(obj.type);
      const objHeader = encodeObjectHeader(typeNum, data.length);

      // 使用 zlib 压缩
      const { deflateSync } = require("node:zlib");
      const compressed = deflateSync(data);

      // 记录偏移量（当前已写入的字节数）
      const offset = packParts.reduce((sum, buf) => sum + buf.length, 0);

      // 计算 CRC32（对象头部 + 压缩数据）
      const objData = Buffer.concat([objHeader, compressed]);
      const crc = crc32Value(objData);

      entries.push({ hash, offset, crc32: crc });
      packParts.push(objHeader, compressed);
    }

    // 计算 packfile 校验和
    const packWithoutChecksum = Buffer.concat(packParts);
    const packChecksum = createHash("sha1").update(packWithoutChecksum).digest();
    const packData = Buffer.concat([packWithoutChecksum, packChecksum]);

    // 构建索引文件
    const idxWriter = new PackIndexWriter();
    for (const entry of entries) {
      idxWriter.addEntry(entry);
    }
    const idxData = idxWriter.build(packChecksum);

    // 生成文件名
    const checksumHex = packChecksum.toString("hex");
    const packPath = join(packDir, `pack-${checksumHex}.pack`);
    const idxPath = join(packDir, `pack-${checksumHex}.idx`);

    // 写入文件
    writeFileSync(packPath, packData);
    writeFileSync(idxPath, idxData);

    return {
      packPath,
      idxPath,
      checksum: checksumHex,
      objectCount: this.objects.length,
    };
  }
}

// ============================================================================
// CRC32 计算
// ============================================================================

/**
 * 计算数据的 CRC32 校验和
 *
 * 使用标准 CRC32 算法（与 Git 兼容）。
 */
function crc32Value(data: Buffer): number {
  // CRC32 查找表
  const table = getCRC32Table();

  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]!) & 0xff]!;
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC32 查找表缓存 */
let crc32Table: Uint32Array | null = null;

/**
 * 获取或生成 CRC32 查找表
 */
function getCRC32Table(): Uint32Array {
  if (crc32Table) return crc32Table;

  crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xedb88320;
      } else {
        crc = crc >>> 1;
      }
    }
    crc32Table[i] = crc;
  }

  return crc32Table;
}
