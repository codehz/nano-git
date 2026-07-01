/**
 * 语义层 <-> Raw 对象转换 helper
 *
 * ODB 的真实边界是 RawGitObject，不是 GitObject。
 * 本模块提供两者之间的双向转换工具，以及便捷的读写封装。
 *
 * 创建路径：GitObject → encodeObject() → RawGitObject → db.ingest()
 * 读取路径：source.read() → RawGitObject → decodeObject() → GitObject
 */

import { hashObject } from "../hash/index.ts";
import { serializeContent, deserializeContent } from "./codec.ts";

import type { GitObject, RawGitObject, SHA1 } from "../types/index.ts";
import type { ObjectDatabase, ObjectSource } from "../types/odb.ts";

/**
 * 将语义对象编码为 RawGitObject
 *
 * 内部复用 serializeContent() 计算内容字节，
 * 并用 hashObject() 计算 canonical SHA-1。
 *
 * @param obj - 语义层 Git 对象
 * @returns 可用于 ODB ingest 的原始对象
 *
 * @example
 * ```ts
 * const blob: GitBlob = { type: "blob", content: Buffer.from("hello") };
 * const raw = encodeObject(blob);
 * console.log(raw.hash); // => SHA-1
 * console.log(raw.content); // => Buffer("hello")
 * ```
 */
export function encodeObject(obj: GitObject): RawGitObject {
  const content = serializeContent(obj);
  const hash = hashObject(obj.type, content);
  return { hash, type: obj.type, content };
}

/**
 * 将 RawGitObject 解码为语义对象
 *
 * 内部复用 deserializeContent() 解析对象内容。
 *
 * @param raw - 来自 ODB 的原始对象
 * @returns 语义层 Git 对象（含类型特定的字段）
 *
 * @example
 * ```ts
 * const raw: RawGitObject = { hash, type: "blob", content: Buffer.from("hello") };
 * const obj = decodeObject(raw);
 * console.log(obj.type); // => "blob"
 * ```
 */
export function decodeObject(raw: RawGitObject): GitObject {
  return deserializeContent(raw.type, raw.content);
}

/**
 * 将语义对象写入对象数据库
 *
 * 先 encode 再 ingest，返回计算得到的哈希。
 *
 * @param db - 对象数据库
 * @param obj - 语义层 Git 对象
 * @returns 对象的 SHA-1 哈希
 *
 * @example
 * ```ts
 * const hash = writeObject(db, { type: "blob", content: Buffer.from("hello") });
 * ```
 */
export function writeObject(db: ObjectDatabase, obj: GitObject): SHA1 {
  const raw = encodeObject(obj);
  db.ingest(raw);
  return raw.hash;
}

/**
 * 从对象源读取并解码语义对象
 *
 * @param source - 只读对象源
 * @param hash - 对象哈希
 * @returns 语义层 Git 对象
 *
 * @example
 * ```ts
 * const obj = readObject(source, hash);
 * if (obj.type === "commit") console.log(obj.message);
 * ```
 */
export function readObject(source: ObjectSource, hash: SHA1): GitObject {
  return decodeObject(source.read(hash));
}

/**
 * 尝试从对象源读取并解码语义对象
 *
 * 对象不存在时返回 undefined，不抛出异常。
 *
 * @param source - 只读对象源
 * @param hash - 对象哈希
 * @returns 语义层 Git 对象，或 undefined
 *
 * @example
 * ```ts
 * const obj = tryReadObject(source, hash);
 * if (obj) { ... }
 * ```
 */
export function tryReadObject(source: ObjectSource, hash: SHA1): GitObject | undefined {
  const raw = source.tryRead(hash);
  return raw ? decodeObject(raw) : undefined;
}
