/**
 * Fetch Ref 规划（完整规划模型）
 *
 * 统一处理 ref 映射与 wants 推导，直接产出 FetchPlan。
 * 不再需要独立的两段式设计（RefUpdatePlan + resolveFetchWants）。
 *
 * 职责：
 * - refspec 映射：远端 ref → 本地 ref
 * - hash 比较：记录 hashEqual 标志
 * - 分离 matchedItems 与 refUpdates：只有 !hashEqual 进入 refUpdates
 * - 对象完整性补正：hash 相同但本地对象缺失时仍生成 want（此时 refUpdates 为空）
 * - 冲突检测：同一 localRef 被多个规则映射时抛 RefPlanError
 * - 非通配符规则匹配校验
 *
 * @example
 * ```ts
 * import { planRefUpdates, validateExactRules } from "./fetch-ref-plan.ts";
 *
 * const plan = planRefUpdates(remoteRefs, localRefs, objects, [
 *   { source: "+refs/heads/*", target: "refs/remotes/origin/*" },
 * ]);
 * console.log(plan.wants, plan.refUpdates, plan.matchedItems);
 * ```
 */

import { GitError } from "../core/errors.ts";
import { matchesRefSpec, mapRefName } from "./ref-match.ts";
import { mappingRuleToParsedSpec } from "./refspec.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectSource } from "../odb/types.ts";
import type {
  RefMappingRule,
  FetchPlan,
  MatchedRefItem,
  RefUpdatePlanItem,
  RemoteRef,
} from "./types.ts";

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
// Fetch 规划（合并后的完整流程）
// ============================================================================

/**
 * 规划 ref 更新并推导传输需求
 *
 * 一步完成"远端 ref → 本地 ref"映射、hash 比较、对象完整性校验、want 推导。
 * 如果两个 rule 映射到同一个 `localRef`，直接抛 `RefPlanError`。
 *
 * @param remoteRefs - 远端引用列表
 * @param localRefs - 本地 ref → hash 映射
 * @param objects - 对象存储（用于对象存在性校验）
 * @param rules - 映射规则列表
 * @param depth - 浅克隆深度（可选，用于 deepen 场景）
 * @returns FetchPlan（含 matchedItems / refUpdates / wants；matchedItems ≠ refUpdates）
 *
 * @example
 * ```ts
 * const plan = planRefUpdates(adv.refs, getLocalRefs(refs), objects, [
 *   { source: "+refs/heads/*", target: "refs/remotes/origin/*" },
 * ]);
 * if (plan.needsPackNegotiation) {
 *   await fetchPack(objects, transport, plan.wants, adv);
 * }
 * ```
 */
export function planRefUpdates(
  remoteRefs: RemoteRef[],
  localRefs: Map<string, SHA1>,
  objects: ObjectSource,
  rules: RefMappingRule[],
  depth?: number,
): FetchPlan {
  const parsedSpecs = rules.map(mappingRuleToParsedSpec);
  const matchedRefs: RemoteRef[] = [];
  const matchedItems: MatchedRefItem[] = [];
  const refUpdates: RefUpdatePlanItem[] = [];
  const localRefToFirstRule = new Map<string, number>();
  const wants: SHA1[] = [];
  const seenWant = new Set<SHA1>();

  for (const ref of remoteRefs) {
    for (const spec of parsedSpecs) {
      if (!matchesRefSpec(ref, spec)) continue;

      const localName = mapRefName(ref.name, spec);

      // === 冲突检测：同一 localRef 被多个 rule 映射 ===
      // 取消静默首条优先，改为显式报错
      const ruleIndex = parsedSpecs.indexOf(spec);
      if (localRefToFirstRule.has(localName)) {
        const firstRuleIndex = localRefToFirstRule.get(localName)!;
        const firstRule = rules[firstRuleIndex]!;
        const currentRule = rules[ruleIndex]!;
        throw new RefPlanError(
          `Conflicting refspec rules for "${localName}": ` +
            `"${firstRule.source}:${firstRule.target}" and ` +
            `"${currentRule.source}:${currentRule.target}" ` +
            `both map to the same local ref.`,
        );
      }
      localRefToFirstRule.set(localName, ruleIndex);

      matchedRefs.push(ref);

      const localHash = localRefs.get(localName);
      const hashEqual = localHash === ref.hash;

      const item: MatchedRefItem = {
        remoteRef: ref,
        localRef: localName,
        currentLocalHash: localHash,
        force: spec.force,
        hashEqual,
      };
      matchedItems.push(item);

      // 规则：只有 !hashEqual 才进入 refUpdates
      if (!hashEqual) {
        refUpdates.push(item);
      }

      // wants 规则：
      // - !hashEqual 必须 want
      // - hashEqual 但对象缺失也必须 want（补对象）
      const objectMissing = !objects.exists(ref.hash);
      const needsWant = !hashEqual || objectMissing;

      if (needsWant && !seenWant.has(ref.hash)) {
        seenWant.add(ref.hash);
        wants.push(ref.hash);
      }
    }
  }

  // Deepen 模式：无 wants 但指定了 depth 时，
  // 把所有 matched refs 作为 wants 触发 re-negotiation
  if (wants.length === 0 && depth !== undefined) {
    for (const ref of matchedRefs) {
      if (!seenWant.has(ref.hash)) {
        seenWant.add(ref.hash);
        wants.push(ref.hash);
      }
    }
  }

  return {
    matchedRefs,
    matchedItems,
    refUpdates,
    wants,
    needsPackNegotiation: wants.length > 0,
  };
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
