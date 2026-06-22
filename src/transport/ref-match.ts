/**
 * Ref 模式匹配与名字映射
 *
 * 只处理模式匹配与名字映射，不带 fetch/push 语义。
 *
 * @example
 * ```ts
 * import { matchesRefSpec, mapRefName } from "./ref-match.ts";
 * import { parseRefSpec } from "./refspec.ts";
 *
 * const spec = parseRefSpec("refs/heads/*:refs/remotes/origin/*");
 * const ref = { name: "refs/heads/main", hash: sha1("...") };
 *
 * if (matchesRefSpec(ref, spec)) {
 *   const localName = mapRefName(ref.name, spec);
 *   console.log(localName); // "refs/remotes/origin/main"
 * }
 * ```
 */

import type { ParsedRefSpec } from "./refspec.ts";
import type { RemoteRef } from "./types.ts";

/**
 * 判断远程引用是否匹配 refspec 源模式
 *
 * 通配符 refspec 使用 startsWith 匹配前缀，
 * 精确 refspec 需要完全相等。
 *
 * @param ref - 远程引用
 * @param spec - 解析后的 refspec
 * @returns 是否匹配
 *
 * @example
 * ```ts
 * matchesRefSpec(
 *   { name: "refs/heads/main", hash: sha1("...") },
 *   parseRefSpec("refs/heads/*:refs/remotes/origin/*"),
 * ); // => true
 * ```
 */
export function matchesRefSpec(ref: RemoteRef, spec: ParsedRefSpec): boolean {
  if (spec.isWildcard) {
    return ref.name.startsWith(spec.srcPattern);
  }
  return ref.name === spec.srcPattern;
}

/**
 * 将远程引用名转换为本地引用名
 *
 * @param refName - 远程引用名称
 * @param spec - 解析后的 refspec
 * @returns 映射后的本地引用名称
 *
 * @example
 * ```ts
 * mapRefName("refs/heads/main", parseRefSpec("refs/heads/*:refs/remotes/origin/*"))
 * // => "refs/remotes/origin/main"
 * ```
 */
export function mapRefName(refName: string, spec: ParsedRefSpec): string {
  const suffix = refName.slice(spec.srcPattern.length);
  return `${spec.dstPattern}${suffix}`;
}
