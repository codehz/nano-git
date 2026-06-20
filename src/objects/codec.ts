/**
 * Git 对象编解码
 *
 * 提供完整对象格式与对象内容格式之间的转换能力。
 */

import type { GitObject, ObjectType } from "../core/types.ts";
import { serializeBlob, deserializeBlob } from "./blob.ts";
import { serializeTree, deserializeTree } from "./tree.ts";
import { serializeCommit, deserializeCommit } from "./commit.ts";
import { serializeTag, deserializeTag } from "./tag.ts";

// ============================================================================
// 完整对象编解码
// ============================================================================

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
 *
 * @example
 * ```ts
 * const obj = deserialize(Buffer.from("blob 5\0hello"));
 * console.log(obj.type); // => "blob"
 * ```
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

// ============================================================================
// 内容编解码
// ============================================================================

/**
 * 序列化对象内容（不含 header）
 *
 * @example
 * ```ts
 * const content = serializeContent({ type: "blob", content: Buffer.from("hello") });
 * console.log(content.toString("utf-8")); // => "hello"
 * ```
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
 * @example
 * ```ts
 * const obj = deserializeContent("blob", Buffer.from("hello"));
 * console.log(obj.type); // => "blob"
 * ```
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
