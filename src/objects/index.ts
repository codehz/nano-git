/**
 * Git 对象序列化/反序列化
 *
 * Git 对象的存储格式: "<type> <size>\0<content>"
 *
 * 每种对象类型有特定的内容格式：
 * - Blob: 原始文件内容
 * - Tree: "<mode> <name>\0<20-byte-hash>" 的列表
 * - Commit: 文本格式，包含 tree、parent、author、committer、message
 * - Tag: 文本格式，包含 object、type、tag、tagger、message
 *
 * 扩展点：添加新对象类型时，只需：
 * 1. 在 types.ts 中添加类型定义
 * 2. 在 objects/ 下创建对应的序列化模块
 * 3. 在本文件的 switch 中添加分支
 */

import type { GitObject, ObjectType } from "../core/types.ts";
import { serializeBlob, deserializeBlob } from "./blob.ts";
import { serializeTree, deserializeTree } from "./tree.ts";
import { serializeCommit, deserializeCommit } from "./commit.ts";
import { serializeTag, deserializeTag } from "./tag.ts";

// 重新导出各子模块
export { serializeBlob, deserializeBlob } from "./blob.ts";
export { serializeTree, deserializeTree } from "./tree.ts";
export { serializeCommit, deserializeCommit } from "./commit.ts";
export { serializeTag, deserializeTag } from "./tag.ts";
export { formatAuthor, parseAuthor } from "./author.ts";

/**
 * 序列化 Git 对象为完整的存储格式
 *
 * @example
 * ```ts
 * const blob: GitBlob = { type: "blob", content: Buffer.from("hello") };
 * const data = serialize(blob);
 * // => Buffer("blob 5\0hello")
 * ```
 */
export function serialize(obj: GitObject): Buffer {
  const content = serializeContent(obj);
  const header = `${obj.type} ${content.length}\0`;
  return Buffer.concat([Buffer.from(header), content]);
}

/**
 * 反序列化完整的存储格式为 Git 对象
 */
export function deserialize(data: Buffer): GitObject {
  const nullIndex = data.indexOf(0);
  if (nullIndex === -1) {
    throw new Error("Invalid Git object: missing null byte");
  }

  const header = data.subarray(0, nullIndex).toString("utf-8");
  const match = header.match(/^(blob|tree|commit|tag) (\d+)$/);
  if (!match) {
    throw new Error(`Invalid Git object header: ${header}`);
  }

  const type = match[1] as ObjectType;
  const size = parseInt(match[2]!, 10);
  const content = data.subarray(nullIndex + 1);

  if (content.length !== size) {
    throw new Error(`Size mismatch: header says ${size}, got ${content.length}`);
  }

  return deserializeContent(type, content);
}

/**
 * 序列化对象内容（不含 header）
 *
 * 扩展点：添加新对象类型时在此添加 case 分支
 */
export function serializeContent(obj: GitObject): Buffer {
  switch (obj.type) {
    case "blob":
      return serializeBlob(obj);
    case "tree":
      return serializeTree(obj);
    case "commit":
      return serializeCommit(obj);
    case "tag":
      return serializeTag(obj);
  }
}

/**
 * 反序列化对象内容（不含 header）
 *
 * 扩展点：添加新对象类型时在此添加 case 分支
 */
export function deserializeContent(type: ObjectType, content: Buffer): GitObject {
  switch (type) {
    case "blob":
      return deserializeBlob(content);
    case "tree":
      return deserializeTree(content);
    case "commit":
      return deserializeCommit(content);
    case "tag":
      return deserializeTag(content);
  }
}
