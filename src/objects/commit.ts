/**
 * Commit 对象序列化/反序列化
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

import { InvalidObjectError } from "../core/errors.ts";
import { sha1 } from "../core/types.ts";
import { formatAuthor, parseAuthor } from "./author.ts";

import type { GitCommit, SHA1 } from "../core/types.ts";

/**
 * 序列化 Commit 对象
 *
 * @example
 * ```ts
 * const commit: GitCommit = {
 *   type: "commit",
 *   tree: sha1("abc..."),
 *   parents: [],
 *   author: { name: "John", email: "j@e.com", timestamp: 123, timezone: "+0800" },
 *   committer: { name: "John", email: "j@e.com", timestamp: 123, timezone: "+0800" },
 *   message: "Initial commit",
 * };
 * const buf = serializeCommit(commit);
 * ```
 */
export function serializeCommit(commit: GitCommit): Buffer {
  const lines: string[] = [];

  lines.push(`tree ${commit.tree}`);

  for (const parent of commit.parents) {
    lines.push(`parent ${parent}`);
  }

  lines.push(`author ${formatAuthor(commit.author)}`);
  lines.push(`committer ${formatAuthor(commit.committer)}`);
  lines.push(""); // 空行分隔 header 和 message
  // Git 确保 message 末尾恰好有一个换行符，保证相同内容产生相同的哈希
  lines.push(commit.message.replace(/\n+$/, ""));

  return Buffer.from(lines.join("\n") + "\n", "utf-8");
}

/**
 * 反序列化 Commit 对象
 */
export function deserializeCommit(content: Buffer): GitCommit {
  const text = content.toString("utf-8");
  const lines = text.split("\n");

  let tree: SHA1 | undefined;
  const parents: SHA1[] = [];
  let author: ReturnType<typeof parseAuthor> | undefined;
  let committer: ReturnType<typeof parseAuthor> | undefined;
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
      throw new InvalidObjectError(`invalid commit header: ${line}`);
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

  if (!tree) throw new InvalidObjectError("commit missing tree");
  if (!author) throw new InvalidObjectError("commit missing author");
  if (!committer) throw new InvalidObjectError("commit missing committer");

  // 剩余部分是 message
  // Git 序列化时会在末尾添加一个换行符，反序列化时需要去掉
  const message = lines.slice(messageStart).join("\n").replace(/\n$/, "");

  return { type: "commit", tree, parents, author, committer, message };
}
