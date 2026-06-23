/**
 * 文件哈希入口
 *
 * 计算文件的 SHA-1 哈希。拉入 `node:fs`。
 *
 * @example
 * ```ts
 * import { hashFile } from "nano-git/hash-file";
 * const hash = hashFile("/path/to/file");
 * ```
 */

export { hashFile } from "./core/hash-file.ts";
