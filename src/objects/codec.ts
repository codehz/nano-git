/**
 * Git 对象编解码
 *
 * 提供完整对象格式与对象内容格式之间的转换能力。
 */

import { concatBytes, bytesToUtf8, utf8ToBytes } from "../bytes.ts";
import { InvalidObjectError } from "../errors.ts";
import { assertObjectType } from "../types/index.ts";
import { serializeBlob, deserializeBlob } from "./blob.ts";
import { serializeCommit, deserializeCommit } from "./commit.ts";
import { serializeTag, deserializeTag } from "./tag.ts";
import { serializeTree, deserializeTree } from "./tree.ts";

import type { GitObject, ObjectType } from "../types/index.ts";

// ============================================================================
// 完整对象编解码
// ============================================================================

/**
 * 序列化 Git 对象为完整的存储格式
 *
 * @example
 * ```ts
 * const blob: GitBlob = { type: "blob", content: new TextEncoder().encode("hello") };
 * const data = serialize(blob);
 * // => Uint8Array("blob 5\0hello")
 * ```
 */
export function serialize(obj: GitObject): Uint8Array {
  const content = serializeContent(obj);
  const header = `${obj.type} ${content.length}\0`;
  return concatBytes(utf8ToBytes(header), content);
}

/**
 * 反序列化完整的存储格式为 Git 对象
 *
 * @example
 * ```ts
 * const obj = deserialize(new TextEncoder().encode("blob 5\0hello"));
 * console.log(obj.type); // => "blob"
 * ```
 */
export function deserialize(data: Uint8Array): GitObject {
  const nullIndex = data.indexOf(0);
  if (nullIndex === -1) {
    throw new InvalidObjectError("missing null byte");
  }

  const header = bytesToUtf8(data.subarray(0, nullIndex));
  const match = header.match(/^(blob|tree|commit|tag) (\d+)$/);
  if (!match) {
    throw new InvalidObjectError(`invalid header: ${header}`);
  }

  const type = assertObjectType(match[1]!);
  const size = parseInt(match[2]!, 10);
  const content = data.subarray(nullIndex + 1);

  if (content.length !== size) {
    throw new InvalidObjectError(`size mismatch: header says ${size}, got ${content.length}`);
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
 * const content = serializeContent({ type: "blob", content: new TextEncoder().encode("hello") });
 * console.log(new TextDecoder().decode(content)); // => "hello"
 * ```
 */
export function serializeContent(obj: GitObject): Uint8Array {
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
 * const obj = deserializeContent("blob", new TextEncoder().encode("hello"));
 * console.log(obj.type); // => "blob"
 * ```
 */
export function deserializeContent(type: ObjectType, content: Uint8Array): GitObject {
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
