/**
 * 作者信息格式化与解析
 *
 * Git 中作者信息的格式:
 *   "<name> <<email>> <timestamp> <timezone>"
 *
 * 例如: "John Doe <john@example.com> 1234567890 +0800"
 *
 * 此格式在 commit 和 tag 对象中共享使用。
 */

import type { GitAuthor } from "../core/types.ts";

/**
 * 格式化作者信息为 Git 标准格式
 *
 * @example
 * ```ts
 * formatAuthor({ name: "John", email: "j@e.com", timestamp: 123, timezone: "+0800" })
 * // => "John <j@e.com> 123 +0800"
 * ```
 */
export function formatAuthor(author: GitAuthor): string {
  return `${author.name} <${author.email}> ${author.timestamp} ${author.timezone}`;
}

/**
 * 解析 Git 标准格式的作者信息
 *
 * @example
 * ```ts
 * parseAuthor("John <j@e.com> 123 +0800")
 * // => { name: "John", email: "j@e.com", timestamp: 123, timezone: "+0800" }
 * ```
 */
export function parseAuthor(text: string): GitAuthor {
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
