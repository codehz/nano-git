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
 */

import type {
  GitObject,
  GitBlob,
  GitTree,
  GitCommit,
  GitTag,
  TreeEntry,
  GitAuthor,
  ObjectType,
  SHA1,
} from "./types.ts";
import { sha1 } from "./types.ts";

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

// ============================================================================
// Blob
// ============================================================================

function serializeBlob(blob: GitBlob): Buffer {
  return blob.content;
}

function deserializeBlob(content: Buffer): GitBlob {
  return { type: "blob", content };
}

// ============================================================================
// Tree
// ============================================================================

/**
 * 序列化 Tree 对象
 *
 * Tree 的二进制格式：
 * 每个条目: "<mode> <name>\0<20-byte-hash>"
 * - mode: 文件模式（如 "100644"）
 * - name: 文件名
 * - hash: 20 字节的原始 SHA-1（不是十六进制字符串）
 */
function serializeTree(tree: GitTree): Buffer {
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
function deserializeTree(content: Buffer): GitTree {
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

// ============================================================================
// Commit
// ============================================================================

/**
 * 序列化 Commit 对象
 *
 * Commit 的文本格式：
 * ```
 * tree <hash>
 * parent <hash>
 * parent <hash>
 * author <name> <email> <timestamp> <timezone>
 * committer <name> <email> <timestamp> <timezone>
 *
 * <message>
 * ```
 */
function serializeCommit(commit: GitCommit): Buffer {
  const lines: string[] = [];

  lines.push(`tree ${commit.tree}`);

  for (const parent of commit.parents) {
    lines.push(`parent ${parent}`);
  }

  lines.push(`author ${formatAuthor(commit.author)}`);
  lines.push(`committer ${formatAuthor(commit.committer)}`);
  lines.push(""); // 空行分隔 header 和 message
  lines.push(commit.message);

  return Buffer.from(lines.join("\n"), "utf-8");
}

/**
 * 反序列化 Commit 对象
 */
function deserializeCommit(content: Buffer): GitCommit {
  const text = content.toString("utf-8");
  const lines = text.split("\n");

  let tree: SHA1 | undefined;
  const parents: SHA1[] = [];
  let author: GitAuthor | undefined;
  let committer: GitAuthor | undefined;
  let messageStart = 0;

  // 解析 headers
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // 空行表示 header 结束
    if (line === "") {
      messageStart = i + 1;
      break;
    }

    const spaceIndex = line.indexOf(" ");
    if (spaceIndex === -1) {
      throw new Error(`Invalid commit header: ${line}`);
    }

    const key = line.slice(0, spaceIndex);
    const value = line.slice(spaceIndex + 1);

    switch (key) {
      case "tree":
        tree = sha1(value);
        break;
      case "parent":
        parents.push(sha1(value));
        break;
      case "author":
        author = parseAuthor(value);
        break;
      case "committer":
        committer = parseAuthor(value);
        break;
    }
  }

  if (!tree) throw new Error("Commit missing tree");
  if (!author) throw new Error("Commit missing author");
  if (!committer) throw new Error("Commit missing committer");

  // 剩余部分是 message
  const message = lines.slice(messageStart).join("\n");

  return { type: "commit", tree, parents, author, committer, message };
}

// ============================================================================
// Tag
// ============================================================================

/**
 * 序列化 Tag 对象
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
function serializeTag(tag: GitTag): Buffer {
  const lines: string[] = [];

  lines.push(`object ${tag.object}`);
  lines.push(`type ${tag.objectType}`);
  lines.push(`tag ${tag.tag}`);
  lines.push(`tagger ${formatAuthor(tag.tagger)}`);
  lines.push(""); // 空行分隔
  lines.push(tag.message);

  return Buffer.from(lines.join("\n"), "utf-8");
}

/**
 * 反序列化 Tag 对象
 */
function deserializeTag(content: Buffer): GitTag {
  const text = content.toString("utf-8");
  const lines = text.split("\n");

  let object: SHA1 | undefined;
  let objectType: ObjectType | undefined;
  let tagName: string | undefined;
  let tagger: GitAuthor | undefined;
  let messageStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line === "") {
      messageStart = i + 1;
      break;
    }

    const spaceIndex = line.indexOf(" ");
    if (spaceIndex === -1) {
      throw new Error(`Invalid tag header: ${line}`);
    }

    const key = line.slice(0, spaceIndex);
    const value = line.slice(spaceIndex + 1);

    switch (key) {
      case "object":
        object = sha1(value);
        break;
      case "type":
        objectType = value as ObjectType;
        break;
      case "tag":
        tagName = value;
        break;
      case "tagger":
        tagger = parseAuthor(value);
        break;
    }
  }

  if (!object) throw new Error("Tag missing object");
  if (!objectType) throw new Error("Tag missing type");
  if (!tagName) throw new Error("Tag missing tag name");
  if (!tagger) throw new Error("Tag missing tagger");

  const message = lines.slice(messageStart).join("\n");

  return { type: "tag", object, objectType, tag: tagName, tagger, message };
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 格式化作者信息
 *
 * 格式: "<name> <<email>> <timestamp> <timezone>"
 * 例如: "John Doe <john@example.com> 1234567890 +0800"
 */
function formatAuthor(author: GitAuthor): string {
  return `${author.name} <${author.email}> ${author.timestamp} ${author.timezone}`;
}

/**
 * 解析作者信息
 *
 * 输入: "John Doe <john@example.com> 1234567890 +0800"
 * 输出: { name, email, timestamp, timezone }
 */
function parseAuthor(text: string): GitAuthor {
  // 匹配: name <email> timestamp timezone
  const match = text.match(/^(.+?) <(.+?)> (\d+) ([+-]\d{4})$/);
  if (!match) {
    throw new Error(`Invalid author format: ${text}`);
  }

  return {
    name: match[1]!,
    email: match[2]!,
    timestamp: parseInt(match[3]!, 10),
    timezone: match[4]!,
  };
}
