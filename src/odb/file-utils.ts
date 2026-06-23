/**
 * loose object 文件系统辅助函数
 *
 * 负责对象路径计算、压缩读写与对象目录枚举。
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

import { InvalidObjectError } from "../core/errors.ts";
import { hashToPath } from "../core/hash.ts";
import { sha1, assertObjectType } from "../core/types.ts";
import { serialize, deserialize } from "../objects/index.ts";

import type { GitObject, RawGitObject, SHA1 } from "../core/types.ts";

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
 * 删除 loose object 文件
 *
 * 删除不存在的对象时静默成功（no-op）。
 *
 * @param objectsDir - .git/objects 目录路径
 * @param hash - 要删除的对象哈希
 *
 * @example
 * ```ts
 * deleteLooseObject(objectsDir, hash);
 * ```
 */
export function deleteLooseObject(objectsDir: string, hash: SHA1): void {
  const objectPath = getLooseObjectPath(objectsDir, hash);
  if (existsSync(objectPath)) {
    unlinkSync(objectPath);
  }
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

/**
 * 写入 raw loose object 文件（使用 canonical bytes）
 *
 * 直接以 "<type> <size>\0<content>" 格式 deflate 写入，
 * 不经过语义序列化。
 *
 * @param objectsDir - .git/objects 目录路径
 * @param raw - 原始对象
 *
 * @example
 * ```ts
 * writeRawLooseObject(objectsDir, raw);
 * ```
 */
export function writeRawLooseObject(objectsDir: string, raw: RawGitObject): void {
  const objectPath = getLooseObjectPath(objectsDir, raw.hash);
  const dir = join(objectsDir, raw.hash.slice(0, 2));
  mkdirSync(dir, { recursive: true });

  const header = `${raw.type} ${raw.content.length}\0`;
  const data = Buffer.concat([Buffer.from(header), raw.content]);
  writeFileSync(objectPath, deflateSync(data));
}

/**
 * 读取 raw loose object 文件
 *
 * 读取后直接返回 { hash, type, content }，
 * 不经过语义反序列化。
 *
 * @param objectsDir - .git/objects 目录路径
 * @param hash - 对象哈希
 * @returns 原始对象
 *
 * @example
 * ```ts
 * const raw = readRawLooseObject(objectsDir, hash);
 * console.log(raw.type, raw.content.length);
 * ```
 */
export function readRawLooseObject(objectsDir: string, hash: SHA1): RawGitObject {
  const objectPath = getLooseObjectPath(objectsDir, hash);
  if (!existsSync(objectPath)) {
    throw new Error(`Object not found: ${hash}`);
  }

  const compressed = readFileSync(objectPath);
  const data = inflateSync(compressed);

  const nullIndex = data.indexOf(0);
  if (nullIndex === -1) {
    throw new InvalidObjectError("missing null byte in loose object");
  }

  const header = data.subarray(0, nullIndex).toString("utf-8");
  const match = header.match(/^(blob|tree|commit|tag) (\d+)$/);
  if (!match) {
    throw new InvalidObjectError(`invalid loose object header: ${header}`);
  }

  const type = assertObjectType(match[1]!);
  const size = parseInt(match[2]!, 10);
  const content = data.subarray(nullIndex + 1);

  if (content.length !== size) {
    throw new InvalidObjectError(`size mismatch: header says ${size}, got ${content.length}`);
  }

  return { hash, type, content };
}
