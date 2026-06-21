/**
 * Ref 选择、映射与 want 规划
 *
 * 解析 ref 映射规则，从远端 refs 和本地 refs 生成更新计划，
 * 产出 wants / matched refs / update items。
 *
 * 此模块不感知 `HEAD` 语义，不涉及 remote 配置持久化。
 *
 * @example
 * ```ts
 * const plan = planRefUpdates(remoteRefs, localRefs, [
 *   { source: "+refs/heads/*", target: "refs/remotes/origin/*" },
 * ]);
 * console.log(plan.wants);
 * ```
 */

import { GitError } from "../core/errors.ts";
import { sha1 } from "../core/types.ts";
import { resolveRefHash } from "../refs/resolve.ts";
import { HEAD_REF } from "../refs/types.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectSource } from "../odb/types.ts";
import type { RefStore } from "../refs/types.ts";
import type { RefMappingRule, RefUpdatePlan, RefUpdatePlanItem } from "./types.ts";
import type { RemoteRef } from "./types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * Ref 规划错误
 */
export class RefPlanError extends GitError {
  constructor(message: string) {
    super(`Ref plan error: ${message}`);
    this.name = "RefPlanError";
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
    throw new RefPlanError(`Invalid refspec: "${refSpec}" (missing ":")`);
  }

  const src = spec.substring(0, colonIndex);
  const dst = spec.substring(colonIndex + 1);

  for (const [sideName, side] of [["src", src] as const, ["dst", dst] as const]) {
    const starCount = (side.match(/\*/g) ?? []).length;
    if (starCount > 1) {
      throw new RefPlanError(`Invalid refspec: "${refSpec}" (multiple wildcards in ${sideName})`);
    }
    if (starCount === 1 && !side.endsWith("*")) {
      throw new RefPlanError(
        `Invalid refspec: "${refSpec}" (wildcard must be at the end of ${sideName})`,
      );
    }
  }

  const srcHasStar = src.endsWith("*");
  const dstHasStar = dst.endsWith("*");

  if (srcHasStar !== dstHasStar) {
    throw new RefPlanError(`Invalid refspec: "${refSpec}" (wildcard must appear on both sides)`);
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

// ============================================================================
// Ref 匹配与映射
// ============================================================================

/**
 * 判断远程引用是否匹配 refspec 源模式
 *
 * 通配符 refspec 使用 startsWith 匹配前缀，
 * 精确 refspec 需要完全相等。
 */
export function matchesRefSpec(ref: RemoteRef, spec: ParsedRefSpec): boolean {
  if (spec.isWildcard) {
    return ref.name.startsWith(spec.srcPattern);
  }
  return ref.name === spec.srcPattern;
}

/**
 * 将远程引用名转换为本地引用名
 */
export function mapRefName(refName: string, spec: ParsedRefSpec): string {
  const suffix = refName.slice(spec.srcPattern.length);
  return `${spec.dstPattern}${suffix}`;
}

// ============================================================================
// 本地 refs 收集
// ============================================================================

/**
 * 获取本地 refs 的哈希映射
 *
 * 扫描 refs/ 下所有命名空间的引用，确保 fetch refspec 中
 * 自定义目标命名空间（如 refs/mirrors/）也能被正确检测到。
 */
export function getLocalRefs(refs: RefStore): Map<string, SHA1> {
  const map = new Map<string, SHA1>();

  for (const refName of refs.listAll()) {
    const content = refs.read(refName);
    if (content && /^[0-9a-f]{40}$/.test(content)) {
      try {
        map.set(refName, sha1(content));
      } catch {
        // 忽略无效哈希
      }
    }
  }

  try {
    const hash = resolveRefHash(refs, HEAD_REF);
    if (hash) {
      map.set(HEAD_REF, hash);
    }
  } catch {
    // 忽略解析失败
  }

  return map;
}

// ============================================================================
// Ref 更新规划
// ============================================================================

/**
 * 规划 ref 更新
 *
 * 从远端 refs 和本地 refs 生成更新计划，产出 wants / matched refs / update items。
 *
 * @param remoteRefs - 远端引用列表
 * @param localRefs - 本地 ref → hash 映射
 * @param rules - 映射规则列表
 * @param store - 可选的对象存储，用于校验本地对象是否存在
 * @returns Ref 更新计划
 *
 * @example
 * ```ts
 * const plan = planRefUpdates(remoteRefs, localRefs, [
 *   { source: "+refs/heads/*", target: "refs/remotes/origin/*" },
 * ]);
 * ```
 */
export function planRefUpdates(
  remoteRefs: RemoteRef[],
  localRefs: Map<string, SHA1>,
  rules: RefMappingRule[],
  store?: ObjectSource,
): RefUpdatePlan {
  const parsedSpecs = rules.map(mappingRuleToParsedSpec);
  const wants: SHA1[] = [];
  const matchedRemoteRefs: RemoteRef[] = [];
  const updates: RefUpdatePlanItem[] = [];
  const seen = new Set<string>();

  for (const ref of remoteRefs) {
    for (const spec of parsedSpecs) {
      if (!matchesRefSpec(ref, spec)) continue;

      const localName = mapRefName(ref.name, spec);

      // 重叠规则去重：同一 localName 只保留首个
      if (seen.has(localName)) continue;
      seen.add(localName);

      matchedRemoteRefs.push(ref);

      // 检查本地是否已是最新
      const localHash = localRefs.get(localName);
      if (localHash === ref.hash && (!store || store.exists(localHash))) {
        continue;
      }

      wants.push(ref.hash);
      updates.push({
        remoteRef: ref,
        localRef: localName,
        currentLocalHash: localHash,
        force: spec.force,
      });
    }
  }

  return { wants, matchedRemoteRefs, updates };
}

/**
 * 校验显式非通配符规则匹配
 *
 * 对非通配符规则，确保每个源模式至少匹配一个远端引用。
 * 通配符规则无匹配时静默通过。
 *
 * @throws RefPlanError 如果非通配符规则无匹配
 */
export function validateExactRules(remoteRefs: RemoteRef[], rules: RefMappingRule[]): void {
  for (const rule of rules) {
    if (rule.source.includes("*")) continue;
    // source 可能以 + 开头表示强制，匹配时去除
    const cleanSource = rule.source.startsWith("+") ? rule.source.slice(1) : rule.source;
    const matched = remoteRefs.some((ref) => ref.name === cleanSource);
    if (!matched) {
      throw new RefPlanError(`Couldn't find remote ref "${cleanSource}"`);
    }
  }
}
