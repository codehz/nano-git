/**
 * Tag 对象序列化/反序列化
 *
 * Tag 的文本格式：
 * ```
 * object <hash>
 * type <type>
 * tag <name>
 * tagger <name> <email> <timestamp> <timezone>
 *
 * <message>
 * ```
 */

import { InvalidObjectError } from "../core/errors.ts";
import { assertObjectType, sha1 } from "../core/types.ts";
import { formatAuthor, parseAuthor } from "./author.ts";

import type { GitTag, ObjectType, SHA1 } from "../core/types.ts";

/**
 * 序列化 Tag 对象
 *
 * @example
 * ```ts
 * const tag: GitTag = {
 *   type: "tag",
 *   object: sha1("abc..."),
 *   objectType: "commit",
 *   tag: "v1.0.0",
 *   tagger: { name: "John", email: "j@e.com", timestamp: 123, timezone: "+0800" },
 *   message: "Release v1.0.0",
 * };
 * const buf = serializeTag(tag);
 * ```
 */
export function serializeTag(tag: GitTag): Buffer {
  const lines: string[] = [];

  lines.push(`object ${tag.object}`);
  lines.push(`type ${tag.objectType}`);
  lines.push(`tag ${tag.tag}`);
  lines.push(`tagger ${formatAuthor(tag.tagger)}`);
  lines.push(""); // 空行分隔
  // Git 确保 message 末尾恰好有一个换行符，保证相同内容产生相同的哈希
  lines.push(tag.message.replace(/\n+$/, ""));

  return Buffer.from(lines.join("\n") + "\n", "utf-8");
}

/**
 * 反序列化 Tag 对象
 */
export function deserializeTag(content: Buffer): GitTag {
  const text = content.toString("utf-8");
  const lines = text.split("\n");

  let object: SHA1 | undefined;
  let objectType: ObjectType | undefined;
  let tagName: string | undefined;
  let tagger: ReturnType<typeof parseAuthor> | undefined;
  let messageStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line === "") {
      messageStart = i + 1;
      break;
    }

    const spaceIndex = line.indexOf(" ");
    if (spaceIndex === -1) {
      throw new InvalidObjectError(`invalid tag header: ${line}`);
    }

    const key = line.slice(0, spaceIndex);
    const value = line.slice(spaceIndex + 1);

    switch (key) {
      case "object":
        object = sha1(value);
        break;
      case "type":
        objectType = assertObjectType(value);
        break;
      case "tag":
        tagName = value;
        break;
      case "tagger":
        tagger = parseAuthor(value);
        break;
    }
  }

  if (!object) throw new InvalidObjectError("tag missing object");
  if (!objectType) throw new InvalidObjectError("tag missing type");
  if (!tagName) throw new InvalidObjectError("tag missing tag name");
  if (!tagger) throw new InvalidObjectError("tag missing tagger");

  // Git 序列化时会在末尾添加一个换行符，反序列化时需要去掉
  const message = lines.slice(messageStart).join("\n").replace(/\n$/, "");

  return { type: "tag", object, objectType, tag: tagName, tagger, message };
}
