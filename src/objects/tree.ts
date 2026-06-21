/**
 * Tree 对象序列化/反序列化
 *
 * Tree 对象存储目录结构，使用二进制格式：
 * 每个条目: "<mode> <name>\0<20-byte-hash>"
 * - mode: 文件模式（如 "100644"）
 * - name: 文件名
 * - hash: 20 字节的原始 SHA-1（不是十六进制字符串）
 */

import { sha1 } from "../core/types.ts";

import type { GitTree, TreeEntry } from "../core/types.ts";

/**
 * 序列化 Tree 对象
 *
 * @example
 * ```ts
 * const tree: GitTree = {
 *   type: "tree",
 *   entries: [{ mode: "100644", name: "README.md", hash: sha1("abc...") }],
 * };
 * const buf = serializeTree(tree);
 * ```
 */
export function serializeTree(tree: GitTree): Buffer {
  const buffers: Buffer[] = [];

  for (const entry of tree.entries) {
    // "<mode> <name>\0"
    const entryHeader = Buffer.from(`${entry.mode} ${entry.name}\0`, "utf-8");
    // 20 字节的原始哈希
    const entryHash = Buffer.from(entry.hash, "hex");

    if (entryHash.length !== 20) {
      throw new Error(`Invalid SHA-1 hash length: ${entryHash.length}`);
    }

    buffers.push(entryHeader, entryHash);
  }

  return Buffer.concat(buffers);
}

/**
 * 反序列化 Tree 对象
 */
export function deserializeTree(content: Buffer): GitTree {
  const entries: TreeEntry[] = [];
  let offset = 0;

  while (offset < content.length) {
    // 找到 null 字节
    const nullIndex = content.indexOf(0, offset);
    if (nullIndex === -1) {
      throw new Error("Invalid tree: missing null byte");
    }

    // 解析 "<mode> <name>"
    const entryHeader = content.subarray(offset, nullIndex).toString("utf-8");
    const spaceIndex = entryHeader.indexOf(" ");
    if (spaceIndex === -1) {
      throw new Error(`Invalid tree entry: ${entryHeader}`);
    }

    const mode = entryHeader.slice(0, spaceIndex);
    const name = entryHeader.slice(spaceIndex + 1);

    // 读取 20 字节的哈希
    const hashStart = nullIndex + 1;
    const hashEnd = hashStart + 20;
    if (hashEnd > content.length) {
      throw new Error("Invalid tree: truncated hash");
    }

    const hash = content.subarray(hashStart, hashEnd).toString("hex");

    entries.push({ mode, name, hash: sha1(hash) });
    offset = hashEnd;
  }

  return { type: "tree", entries };
}
