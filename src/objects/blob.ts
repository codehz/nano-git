/**
 * Blob 对象序列化/反序列化
 *
 * Blob 是 Git 中最简单的对象类型，直接存储文件的原始内容。
 * 序列化时不需要额外处理，内容即为序列化结果。
 */

import type { GitBlob } from "../types/index.ts";

/**
 * 序列化 Blob 对象
 *
 * Blob 的内容就是原始文件数据，无需额外处理。
 */
export function serializeBlob(blob: GitBlob): Buffer {
  return blob.content;
}

/**
 * 反序列化 Blob 对象
 */
export function deserializeBlob(content: Buffer): GitBlob {
  return { type: "blob", content };
}
