/**
 * Fetch Ref 规划
 *
 * 处理"我要 fetch 哪些 ref"的问题：
 * - 使用 refspec 在远端 refs 与本地 refs 之间映射
 * - 产出 wants / matched refs / update items
 *
 * @example
 * ```ts
 * import { planRefUpdates, validateExactRules } from "./fetch-ref-plan.ts";
 *
 * const plan = planRefUpdates(remoteRefs, localRefs, [
 *   { source: "+refs/heads/*", target: "refs/remotes/origin/*" },
 * ]);
 * console.log(plan.wants);
 * ```
 */

import { GitError } from "../core/errors.ts";
import { getLocalRefs } from "./ref-collection.ts";
import { matchesRefSpec, mapRefName } from "./ref-match.ts";
import { mappingRuleToParsedSpec } from "./refspec.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectSource } from "../odb/types.ts";
import type { RefStore } from "../refs/types.ts";
import type { ParsedRefSpec } from "./refspec.ts";
import type { RefMappingRule, RefUpdatePlan, RefUpdatePlanItem, RemoteRef } from "./types.ts";

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
// 导出 ref-collection 的共享函数（向后兼容）
// ============================================================================

/**
 * @deprecated 请从 "./ref-collection.ts" 直接导入
 */
export { getLocalRefs } from "./ref-collection.ts";

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
