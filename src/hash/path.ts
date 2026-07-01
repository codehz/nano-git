/**
 * 对象哈希路径映射
 *
 * 提供 SHA-1 与 loose object 相对路径之间的转换能力。
 */

import { sha1 } from "../types/index.ts";

import type { SHA1 } from "../types/index.ts";

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
 * isValidSHA1("95d09f2b10159347eece71399a7e2e907ea3df4f"); // => true
 * isValidSHA1("invalid"); // => false
 * ```
 */
export function isValidSHA1(value: string): value is SHA1 {
  return /^[0-9a-f]{40}$/.test(value);
}
