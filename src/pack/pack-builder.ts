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

import { buildEncodedPack, type EncodedPackObject, toEncodedPackObject } from "./pack-encoding.ts";
import { createPackIndexWriter } from "./pack-index.ts";

import type { GitObject, SHA1 } from "../core/types.ts";
import type { PackBuildResult } from "./pack-builder-types.ts";

export type { PackBuildResult } from "./pack-builder-types.ts";

// ============================================================================
// 接口
// ============================================================================

/**
 * Packfile 构建器接口
 */
export interface PackBuilder {
  /** 获取已添加的对象数量 */
  readonly objectCount: number;

  /**
   * 添加一个 Git 对象
   *
   * @param obj - Git 对象
   * @returns 对象的 SHA-1 哈希
   */
  addObject(obj: GitObject): SHA1;

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
  build(): PackBuildResult;
}

// ============================================================================
// 工厂函数
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
  const objects: EncodedPackObject[] = [];
  const hashes: Set<SHA1> = new Set();

  function addObject(obj: GitObject): SHA1 {
    const entry = toEncodedPackObject(obj);
    const hash = entry.hash;

    if (hashes.has(hash)) {
      return hash;
    }

    objects.push(entry);
    hashes.add(hash);
    return hash;
  }

  function build(): PackBuildResult {
    const packDir = join(gitDir, "objects", "pack");
    mkdirSync(packDir, { recursive: true });

    const encoded = buildEncodedPack(objects);

    // 构建索引文件
    const idxWriter = createPackIndexWriter();
    for (const entry of encoded.entries) {
      idxWriter.addEntry(entry);
    }
    const idxData = idxWriter.build(encoded.packChecksum);

    // 生成文件名
    const checksumHex = encoded.packChecksum.toString("hex");
    const packPath = join(packDir, `pack-${checksumHex}.pack`);
    const idxPath = join(packDir, `pack-${checksumHex}.idx`);

    // 写入文件
    writeFileSync(packPath, encoded.packData);
    writeFileSync(idxPath, idxData);

    return {
      packPath,
      idxPath,
      checksum: checksumHex,
      objectCount: objects.length,
    };
  }

  return {
    get objectCount(): number {
      return objects.length;
    },
    addObject,
    build,
  };
}
