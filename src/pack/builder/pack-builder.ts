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

import { bytesToHex } from "../../bytes.ts";
import { createPackIndexWriter } from "../idx/pack-index.ts";
import {
  buildEncodedPack,
  type EncodedPackObject,
  toEncodedPackObject,
} from "../writer/pack-encoding.ts";

import type { RawGitObject, SHA1 } from "../../types/index.ts";
import type { PackBuilder } from "../types.ts";
import type { PackBuildResult } from "./pack-builder-types.ts";

export type { PackBuildResult } from "./pack-builder-types.ts";

// ============================================================================
// 接口
// ============================================================================

export type { PackBuilder } from "../types.ts";

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
 * // 添加原始对象
 * builder.addRaw(raw);
 *
 * // 构建并写入
 * const result = builder.build();
 * console.log(`已打包 ${result.objectCount} 个对象到 ${result.packPath}`);
 * ```
 */
export function createPackBuilder(gitDir: string): PackBuilder {
  const objects: EncodedPackObject[] = [];
  const hashes: Set<SHA1> = new Set();

  function addRaw(raw: RawGitObject): SHA1 {
    const entry = toEncodedPackObject(raw);
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
    const checksumHex = bytesToHex(encoded.packChecksum);
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
    addRaw,
    build,
  };
}
