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

import { InvalidObjectError } from "../errors.ts";
import { assertObjectType, sha1 } from "../types/index.ts";
import { formatAuthor, parseAuthor } from "./author.ts";

import type { GitCommitExtraHeader, GitTag, ObjectType, SHA1 } from "../types/index.ts";

// ============================================================================
// Header 编解码辅助
// ============================================================================

interface ParsedTagHeader {
  readonly name: string;
  value: string;
}

interface PendingTagHeaders {
  object?: SHA1;
  objectType?: ObjectType;
  tag?: string;
  tagger?: ReturnType<typeof parseAuthor>;
  gpgsig?: string;
  readonly extraHeaders: GitCommitExtraHeader[];
}

const BUILTIN_TAG_HEADERS = new Set<string>(["object", "type", "tag", "tagger", "gpgsig"]);

function validateExtraHeaderName(name: string): void {
  if (name.length === 0 || /\s/.test(name) || name.includes("\0")) {
    throw new InvalidObjectError(`invalid tag extra header name: ${name}`);
  }
  if (BUILTIN_TAG_HEADERS.has(name)) {
    throw new InvalidObjectError(
      `tag extra header "${name}" 与内建字段冲突，请改用对应的专用字段。`,
    );
  }
}

function parseTagHeaders(headerText: string): ParsedTagHeader[] {
  if (headerText.length === 0) {
    return [];
  }

  const rawLines = headerText.split("\n");
  const headers: ParsedTagHeader[] = [];
  let current: ParsedTagHeader | undefined;

  for (const line of rawLines) {
    if (line.startsWith(" ")) {
      if (!current) {
        throw new InvalidObjectError("invalid tag header continuation without base header");
      }
      current.value += `\n${line.slice(1)}`;
      continue;
    }

    const spaceIndex = line.indexOf(" ");
    if (spaceIndex === -1) {
      throw new InvalidObjectError(`invalid tag header: ${line}`);
    }

    current = {
      name: line.slice(0, spaceIndex),
      value: line.slice(spaceIndex + 1),
    };
    headers.push(current);
  }

  return headers;
}

function applyParsedHeader(state: PendingTagHeaders, header: ParsedTagHeader): void {
  switch (header.name) {
    case "object":
      if (state.object !== undefined) {
        throw new InvalidObjectError("tag has multiple object headers");
      }
      state.object = sha1(header.value);
      return;
    case "type":
      if (state.objectType !== undefined) {
        throw new InvalidObjectError("tag has multiple type headers");
      }
      state.objectType = assertObjectType(header.value);
      return;
    case "tag":
      if (state.tag !== undefined) {
        throw new InvalidObjectError("tag has multiple tag headers");
      }
      state.tag = header.value;
      return;
    case "tagger":
      if (state.tagger !== undefined) {
        throw new InvalidObjectError("tag has multiple tagger headers");
      }
      state.tagger = parseAuthor(header.value);
      return;
    case "gpgsig":
      if (state.gpgsig !== undefined) {
        throw new InvalidObjectError("tag has multiple gpgsig headers");
      }
      state.gpgsig = header.value;
      return;
    default:
      state.extraHeaders.push({
        name: header.name,
        value: header.value,
      });
  }
}

function encodeTagHeader(name: string, value: string): string[] {
  const parts = value.split("\n");
  const encoded = [`${name} ${parts[0] ?? ""}`];

  for (let i = 1; i < parts.length; i++) {
    encoded.push(` ${parts[i] ?? ""}`);
  }

  return encoded;
}

function buildTagHeaderLines(tag: GitTag): string[] {
  const lines: string[] = [];

  lines.push(`object ${tag.object}`);
  lines.push(`type ${tag.objectType}`);
  lines.push(`tag ${tag.tag}`);
  lines.push(`tagger ${formatAuthor(tag.tagger)}`);

  if (tag.gpgsig !== undefined) {
    lines.push(...encodeTagHeader("gpgsig", tag.gpgsig));
  }

  for (const header of tag.extraHeaders ?? []) {
    validateExtraHeaderName(header.name);
    lines.push(...encodeTagHeader(header.name, header.value));
  }

  return lines;
}

// ============================================================================
// Tag 编解码
// ============================================================================

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
  const lines: string[] = [
    ...buildTagHeaderLines(tag),
    "", // 空行分隔
    // Git 确保 message 末尾恰好有一个换行符，保证相同内容产生相同的哈希
    tag.message.replace(/\n+$/, ""),
  ];

  return Buffer.from(lines.join("\n") + "\n", "utf-8");
}

/**
 * 反序列化 Tag 对象
 */
export function deserializeTag(content: Buffer): GitTag {
  const text = content.toString("utf-8");
  const headerEnd = text.indexOf("\n\n");

  if (headerEnd === -1) {
    throw new InvalidObjectError("tag missing header/body separator");
  }

  const headerText = text.slice(0, headerEnd);
  const parsedHeaders = parseTagHeaders(headerText);

  const state: PendingTagHeaders = {
    extraHeaders: [],
  };

  for (const header of parsedHeaders) {
    applyParsedHeader(state, header);
  }

  if (!state.object) throw new InvalidObjectError("tag missing object");
  if (!state.objectType) throw new InvalidObjectError("tag missing type");
  if (!state.tag) throw new InvalidObjectError("tag missing tag name");
  if (!state.tagger) throw new InvalidObjectError("tag missing tagger");

  // Git 序列化时会在末尾添加一个换行符，反序列化时需要去掉
  const message = text.slice(headerEnd + 2).replace(/\n$/, "");

  return {
    type: "tag",
    object: state.object,
    objectType: state.objectType,
    tag: state.tag,
    tagger: state.tagger,
    gpgsig: state.gpgsig,
    extraHeaders: state.extraHeaders.length > 0 ? state.extraHeaders : undefined,
    message,
  };
}
