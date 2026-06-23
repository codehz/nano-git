/**
 * Glob 模式匹配工具
 *
 * 提供将 glob 模式转换为正则表达式以及判断 ref 名称是否匹配 glob 模式的功能。
 */

// ============================================================================
// Glob 模式匹配
// ============================================================================

/**
 * 将 glob 模式转换为正则表达式
 *
 * 只支持 `*` 通配符（匹配任意字符，包括 /）。
 * 其他字符按字面量匹配。
 *
 * @param pattern - glob 模式，如 "refs/heads/*"
 * @returns RegExp
 *
 * @example
 * ```ts
 * const re = globToRegex("refs/heads/*");
 * re.test("refs/heads/main"); // true
 * re.test("refs/tags/v1");    // false
 * ```
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${regexStr}$`);
}

/**
 * 判断 ref 名称是否匹配 glob 模式
 *
 * @param pattern - glob 模式
 * @param refName - ref 名称
 * @returns 是否匹配
 *
 * @example
 * ```ts
 * matchRefGlob("refs/heads/*", "refs/heads/main"); // true
 * matchRefGlob("refs/tags/v*", "refs/tags/v1.0");  // true
 * ```
 */
export function matchRefGlob(pattern: string, refName: string): boolean {
  return globToRegex(pattern).test(refName);
}
