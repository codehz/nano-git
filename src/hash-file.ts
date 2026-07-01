/**
 * 文件内容 SHA-1 哈希入口
 *
 * 提供以 blob 语义计算文件哈希的辅助函数。
 *
 * 单独拆分文件系统依赖，避免纯内存入口被 `node:fs` 污染。
 */

import { readFileSync } from "node:fs";

import { hashObject } from "./hash/index.ts";

import type { SHA1 } from "./types/index.ts";

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
