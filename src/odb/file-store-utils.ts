/**
 * loose object 文件系统辅助函数
 *
 * 负责对象路径计算、压缩读写与对象目录枚举。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { GitObject, SHA1 } from "../core/types.ts";
import { sha1 } from "../core/types.ts";
import { hashToPath } from "../core/hash.ts";
import { serialize, deserialize } from "../objects/index.ts";

/**
 * 计算 loose object 文件路径
 *
 * @example
 * ```ts
 * const path = getLooseObjectPath("/repo/.git/objects", hash);
 * console.log(path);
 * ```
 */
export function getLooseObjectPath(objectsDir: string, hash: SHA1): string {
  return join(objectsDir, hashToPath(hash));
}

/**
 * 检查 loose object 是否存在
 *
 * @example
 * ```ts
 * if (hasLooseObject(objectsDir, hash)) {
 *   console.log("对象已存在");
 * }
 * ```
 */
export function hasLooseObject(objectsDir: string, hash: SHA1): boolean {
  return existsSync(getLooseObjectPath(objectsDir, hash));
}

/**
 * 写入 loose object 文件
 *
 * @example
 * ```ts
 * writeLooseObject(objectsDir, hash, blob);
 * ```
 */
export function writeLooseObject(objectsDir: string, hash: SHA1, obj: GitObject): void {
  const objectPath = getLooseObjectPath(objectsDir, hash);
  const dir = join(objectsDir, hash.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(objectPath, deflateSync(serialize(obj)));
}

/**
 * 读取 loose object 文件
 *
 * @example
 * ```ts
 * const obj = readLooseObject(objectsDir, hash);
 * console.log(obj.type);
 * ```
 */
export function readLooseObject(objectsDir: string, hash: SHA1): GitObject {
  const objectPath = getLooseObjectPath(objectsDir, hash);
  if (!existsSync(objectPath)) {
    throw new Error(`Object not found: ${hash}`);
  }

  const compressed = readFileSync(objectPath);
  return deserialize(inflateSync(compressed));
}

/**
 * 枚举所有 loose object 哈希
 *
 * @example
 * ```ts
 * const hashes = listLooseObjects(objectsDir);
 * console.log(hashes.length);
 * ```
 */
export function listLooseObjects(objectsDir: string): SHA1[] {
  if (!existsSync(objectsDir)) {
    return [];
  }

  const hashes: SHA1[] = [];
  const dirs = readdirSync(objectsDir).sort();

  for (const dirName of dirs) {
    if (dirName === "info" || dirName === "pack" || dirName.length !== 2) {
      continue;
    }

    const dirPath = join(objectsDir, dirName);
    if (!statSync(dirPath).isDirectory()) {
      continue;
    }

    const files = readdirSync(dirPath).sort();
    for (const fileName of files) {
      if (fileName.length !== 38) {
        continue;
      }
      hashes.push(sha1(`${dirName}${fileName}`));
    }
  }

  return hashes;
}
