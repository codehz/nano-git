/**
 * Tree 对象序列化/反序列化
 *
 * Tree 对象存储目录结构，使用二进制格式：
 * 每个条目: "<mode> <name>\0<20-byte-hash>"
 * - mode: 文件模式（如 "100644"）
 * - name: 文件名
 * - hash: 20 字节的原始 SHA-1（不是十六进制字符串）
 *
 * mode 规范化说明：
 * Git CLI 显示目录 mode 为 "040000"（6 位八进制，前导补零），但磁盘上存储为 "40000"（5 字节）。
 * 本模块在序列化/反序列化边界做双向转换，内部统一使用规范形式（"040000"）。
 */

import { InvalidObjectError } from "../core/errors.ts";
import { sha1 } from "../core/types.ts";

import type { GitTree, TreeEntry } from "../core/types.ts";

// ============================================================================
// Mode 规范化工具
// ============================================================================

/**
 * 目录 mode 的磁盘格式（无前导零，5 字节）
 */
const DIR_MODE_ON_DISK = "40000";

/**
 * 目录 mode 的规范格式（有前导零，6 字节，与 git cat-file -p 显示一致）
 */
const DIR_MODE_CANONICAL = "040000";

/**
 * 将 mode 转换为规范形式（6 位八进制）
 *
 * 读取磁盘 tree 条目时调用：将 "40000" → "040000"，其他 mode 不变。
 *
 * @param mode - 来自磁盘的 mode 字符串
 * @returns 规范化的 mode 字符串
 *
 * @example
 * ```ts
 * toCanonicalMode("40000")  // => "040000"
 * toCanonicalMode("100644") // => "100644"
 * ```
 */
export function toCanonicalMode(mode: string): string {
  return mode === DIR_MODE_ON_DISK ? DIR_MODE_CANONICAL : mode;
}

/**
 * 将 mode 转换为磁盘格式（无多余前导零）
 *
 * 写入磁盘 tree 条目时调用：将 "040000" → "40000"，其他 mode 不变。
 *
 * @param mode - 规范形式的 mode 字符串
 * @returns 磁盘形式的 mode 字符串
 *
 * @example
 * ```ts
 * toOnDiskMode("040000") // => "40000"
 * toOnDiskMode("100644") // => "100644"
 * ```
 */
export function toOnDiskMode(mode: string): string {
  return mode === DIR_MODE_CANONICAL ? DIR_MODE_ON_DISK : mode;
}

/**
 * 将 TreeEntry 的 mode 转为规范形式（原地修改）
 */
export function canonicalizeEntry(entry: TreeEntry): TreeEntry {
  if (entry.mode === DIR_MODE_ON_DISK) {
    entry.mode = DIR_MODE_CANONICAL;
  }
  return entry;
}

// ============================================================================
// 序列化 / 反序列化
// ============================================================================

/**
 * 序列化 Tree 对象
 *
 * 写入时自动将规范 mode 转换为磁盘格式（如 "040000" → "40000"）。
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
    // 将规范 mode 转为磁盘格式（如 "040000" → "40000"）
    const mode = toOnDiskMode(entry.mode);
    // "<mode> <name>\0"
    const entryHeader = Buffer.from(`${mode} ${entry.name}\0`, "utf-8");
    // 20 字节的原始哈希
    const entryHash = Buffer.from(entry.hash, "hex");

    if (entryHash.length !== 20) {
      throw new InvalidObjectError(`invalid SHA-1 hash length: ${entryHash.length}`);
    }

    buffers.push(entryHeader, entryHash);
  }

  return Buffer.concat(buffers);
}

/**
 * 反序列化 Tree 对象
 *
 * 读取时自动将磁盘 mode 转换为规范形式（如 "40000" → "040000"）。
 */
export function deserializeTree(content: Buffer): GitTree {
  const entries: TreeEntry[] = [];
  let offset = 0;

  while (offset < content.length) {
    // 找到 null 字节
    const nullIndex = content.indexOf(0, offset);
    if (nullIndex === -1) {
      throw new InvalidObjectError("tree: missing null byte");
    }

    // 解析 "<mode> <name>"
    const entryHeader = content.subarray(offset, nullIndex).toString("utf-8");
    const spaceIndex = entryHeader.indexOf(" ");
    if (spaceIndex === -1) {
      throw new InvalidObjectError(`invalid tree entry: ${entryHeader}`);
    }

    const mode = entryHeader.slice(0, spaceIndex);
    const name = entryHeader.slice(spaceIndex + 1);

    // 读取 20 字节的哈希
    const hashStart = nullIndex + 1;
    const hashEnd = hashStart + 20;
    if (hashEnd > content.length) {
      throw new InvalidObjectError("tree: truncated hash");
    }

    const hash = content.subarray(hashStart, hashEnd).toString("hex");

    // 将磁盘 mode 转为规范形式（如 "40000" → "040000"）
    entries.push({ mode: toCanonicalMode(mode), name, hash: sha1(hash) });
    offset = hashEnd;
  }

  return { type: "tree", entries };
}
