/**
 * 文件内容 SHA-1 哈希入口
 *
 * 单独拆分文件系统依赖，避免纯内存入口被 `node:fs` 污染。
 */

export { hashFile } from "./core/hash-file.ts";
