/**
 * SHA-1 摘要计算
 *
 * 提供原始数据与 Git 对象格式的哈希计算能力。
 */

import { createHash } from "node:crypto";

import { sha1 } from "../types/index.ts";

import type { ObjectType, SHA1 } from "../types/index.ts";

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
