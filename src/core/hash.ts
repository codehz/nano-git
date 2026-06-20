/**
 * SHA-1 哈希工具
 *
 * Git 中所有对象都通过 SHA-1 哈希寻址。
 * 哈希的输入格式为: "<type> <size>\0<content>"
 *
 * 例如一个 blob 对象 "hello world" 的哈希计算：
 *   SHA1("blob 11\0hello world") = "95d09f2b10159347eece71399a7e2e907ea3df4f"
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ObjectType, SHA1 } from "./types.ts";
import { sha1 } from "./types.ts";

/**
 * 计算原始数据的 SHA-1 哈希
 *
 * @param data - 原始数据
 * @returns SHA-1 哈希
 *
 * @example
 * ```ts
 * const hash = hashData("hello");
 * console.log(hash);
 * ```
 */
export function hashData(data: Buffer | string): SHA1 {
  const hash = createHash("sha1");
  hash.update(data);
  return sha1(hash.digest("hex"));
}

/**
 * 计算 Git 对象的 SHA-1 哈希
 *
 * Git 对象的哈希格式: "<type> <size>\0<content>"
 * 这是 Git 寻址的核心，相同内容总是产生相同的哈希。
 *
 * @param type - 对象类型
 * @param content - 对象内容
 * @returns 对象哈希
 *
 * @example
 * ```ts
 * const hash = hashObject("blob", Buffer.from("hello world"));
 * console.log(hash);
 * ```
 */
export function hashObject(type: ObjectType, content: Buffer): SHA1 {
  const header = `${type} ${content.length}\0`;
  const hash = createHash("sha1");
  hash.update(header);
  hash.update(content);
  return sha1(hash.digest("hex"));
}

/**
 * 将 SHA-1 哈希转换为对象存储路径
 *
 * Git 将对象存储在 `.git/objects/` 目录下，
 * 前 2 个字符作为目录名，剩余 38 个字符作为文件名。
 *
 * @param hash - 对象哈希
 * @returns 相对对象路径
 *
 * @example
 * ```ts
 * const path = hashToPath(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));
 * console.log(path);
 * ```
 */
export function hashToPath(hash: SHA1): string {
  return `${hash.slice(0, 2)}/${hash.slice(2)}`;
}

/**
 * 从对象存储路径还原 SHA-1 哈希
 *
 * @param path - 对象相对路径
 * @returns 对应的对象哈希
 *
 * @example
 * ```ts
 * const hash = pathToHash("95/d09f2b10159347eece71399a7e2e907ea3df4f");
 * console.log(hash);
 * ```
 */
export function pathToHash(path: string): SHA1 {
  return sha1(path.replace("/", ""));
}

/**
 * 验证一个字符串是否是有效的 SHA-1 哈希
 *
 * @param value - 待校验字符串
 * @returns 是否为合法 SHA-1
 *
 * @example
 * ```ts
 * console.log(isValidSHA1("95d09f2b10159347eece71399a7e2e907ea3df4f"));
 * ```
 */
export function isValidSHA1(value: string): value is SHA1 {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * 计算文件的 SHA-1 哈希（作为 blob 对象）
 *
 * 等价于 `git hash-object <file>`。
 *
 * @param filePath - 文件路径
 * @returns blob 哈希
 *
 * @example
 * ```ts
 * const hash = hashFile("/tmp/demo.txt");
 * console.log(hash);
 * ```
 */
export function hashFile(filePath: string): SHA1 {
  const content = readFileSync(filePath);
  return hashObject("blob", content);
}
