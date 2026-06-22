/**
 * Fetch Ref 规划（纯映射层）
 *
 * 只负责"远端 ref → 本地 ref"的映射规划，不涉及对象库状态。
 * 使用 refspec 在远端 refs 与本地 refs 之间映射，产出 matched refs / update items。
 *
 * 对象完整性补正由 resolveFetchWants() 在后续阶段完成。
 *
 * @example
 * ```ts
 * import { planRefUpdates, validateExactRules } from "./fetch-ref-plan.ts";
 *
 * const plan = planRefUpdates(remoteRefs, localRefs, [
 *   { source: "+refs/heads/*", target: "refs/remotes/origin/*" },
 * ]);
 * console.log(plan.updates);
 * ```
 */

import { GitError } from "../core/errors.ts";
import { matchesRefSpec, mapRefName } from "./ref-match.ts";
import { mappingRuleToParsedSpec } from "./refspec.ts";

import type { SHA1 } from "../core/types.ts";
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
// Ref 更新规划
// ============================================================================

/**
 * 规划 ref 更新（纯映射）
 *
 * 从远端 refs 和本地 refs 生成更新计划，仅基于 hash 比较决定哪些 ref 需要更新。
 * 不涉及对象库状态校验——对象完整性补正由 resolveFetchWants() 完成。
 *
 * @param remoteRefs - 远端引用列表
 * @param localRefs - 本地 ref → hash 映射
 * @param rules - 映射规则列表
 * @returns Ref 更新计划（不含 wants）
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
): RefUpdatePlan {
  const parsedSpecs = rules.map(mappingRuleToParsedSpec);
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

      // 纯 hash 比较：本地 hash 相同则跳过（对象完整性由后续阶段校验）
      const localHash = localRefs.get(localName);
      if (localHash === ref.hash) {
        continue;
      }

      updates.push({
        remoteRef: ref,
        localRef: localName,
        currentLocalHash: localHash,
        force: spec.force,
      });
    }
  }

  return { matchedRemoteRefs, updates };
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
