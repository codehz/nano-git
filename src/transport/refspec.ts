/**
 * RefSpec 解析与转换
 *
 * 只处理 refspec/mapping rule 的语法与转换，不带 fetch/push 语义。
 *
 * @example
 * ```ts
 * import { parseRefSpec, mappingRuleToParsedSpec } from "./refspec.ts";
 *
 * const spec = parseRefSpec("+refs/heads/*:refs/remotes/origin/*");
 * console.log(spec.force, spec.srcPattern, spec.dstPattern);
 * ```
 */

import { GitError } from "../core/errors.ts";

import type { RefMappingRule } from "./types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * RefSpec 解析错误
 */
export class RefSpecError extends GitError {
  constructor(message: string) {
    super(`Refspec error: ${message}`);
    this.name = "RefSpecError";
  }
}

// ============================================================================
// 类型
// ============================================================================

/**
 * 解析后的 refspec
 */
export interface ParsedRefSpec {
  force: boolean;
  srcPattern: string;
  dstPattern: string;
  /** 原始 refspec 是否包含通配符 * */
  isWildcard: boolean;
}

// ============================================================================
// RefSpec 解析
// ============================================================================

/**
 * 解析 refspec 字符串
 *
 * 格式: [+]<src>:<dst>
 * 其中 + 表示 force push/fetch
 * * 是通配符
 *
 * @example
 * ```ts
 * parseRefSpec("+refs/heads/*:refs/remotes/origin/*")
 * // => { force: true, srcPattern: "refs/heads/", dstPattern: "refs/remotes/origin/", isWildcard: true }
 * ```
 */
export function parseRefSpec(refSpec: string): ParsedRefSpec {
  const force = refSpec.startsWith("+");
  const spec = force ? refSpec.slice(1) : refSpec;

  const colonIndex = spec.indexOf(":");
  if (colonIndex === -1) {
    throw new RefSpecError(`Invalid refspec: "${refSpec}" (missing ":")`);
  }

  const src = spec.substring(0, colonIndex);
  const dst = spec.substring(colonIndex + 1);

  for (const [sideName, side] of [["src", src] as const, ["dst", dst] as const]) {
    const starCount = (side.match(/\*/g) ?? []).length;
    if (starCount > 1) {
      throw new RefSpecError(`Invalid refspec: "${refSpec}" (multiple wildcards in ${sideName})`);
    }
    if (starCount === 1 && !side.endsWith("*")) {
      throw new RefSpecError(
        `Invalid refspec: "${refSpec}" (wildcard must be at the end of ${sideName})`,
      );
    }
  }

  const srcHasStar = src.endsWith("*");
  const dstHasStar = dst.endsWith("*");

  if (srcHasStar !== dstHasStar) {
    throw new RefSpecError(`Invalid refspec: "${refSpec}" (wildcard must appear on both sides)`);
  }

  const isWildcard = srcHasStar;
  const srcPattern = src.replace(/\*$/, "");
  const dstPattern = dst.replace(/\*$/, "");

  return { force, srcPattern, dstPattern, isWildcard };
}

/**
 * 将 RefMappingRule 转换为 ParsedRefSpec
 */
export function mappingRuleToParsedSpec(rule: RefMappingRule): ParsedRefSpec {
  // source 可能包含 + 前缀（如 "+refs/heads/*"），此时 force 继承自 + 前缀
  const forceFromSource = rule.source.startsWith("+");
  const cleanSource = forceFromSource ? rule.source.slice(1) : rule.source;
  const effectiveForce = rule.force ?? forceFromSource;
  const refSpec = `${effectiveForce ? "+" : ""}${cleanSource}:${rule.target}`;
  return parseRefSpec(refSpec);
}

/**
 * 将 ParsedRefSpec 转换为 RefMappingRule
 */
export function parsedSpecToMappingRule(spec: ParsedRefSpec): RefMappingRule {
  return {
    source: spec.isWildcard ? `${spec.srcPattern}*` : spec.srcPattern,
    target: spec.isWildcard ? `${spec.dstPattern}*` : spec.dstPattern,
    force: spec.force,
  };
}
