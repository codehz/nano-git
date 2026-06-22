/**
 * Fetch 传输计划补正
 *
 * 在纯 ref 映射计划（RefUpdatePlan）基础上，结合对象库状态推导出实际传输需求：
 * - 对象完整性校验：hash 相同但对象缺失时仍需 want
 * - 特殊场景处理：shallow deepen 等
 *
 * 职责边界：
 * - `planRefUpdates()` 产出"理论上要更新哪些 ref"
 * - `resolveFetchWants()` 产出"实际上要向服务器要哪些对象"
 *
 * @example
 * ```ts
 * import { planRefUpdates } from "./fetch-ref-plan.ts";
 * import { resolveFetchWants } from "./fetch-plan-finalize.ts";
 *
 * const plan = planRefUpdates(remoteRefs, localRefs, rules);
 * const transferPlan = resolveFetchWants(plan, objects);
 * console.log(`Need to fetch ${transferPlan.wants.length} objects`);
 * ```
 */

import type { SHA1 } from "../core/types.ts";
import type { ObjectSource } from "../odb/types.ts";
import type { FetchTransferPlan, RefUpdatePlan } from "./types.ts";

// ============================================================================
// 选项类型
// ============================================================================

/**
 * resolveFetchWants 选项
 */
export interface ResolveFetchWantsOptions {
  /** 浅克隆深度 */
  readonly depth?: number;
}

// ============================================================================
// 传输计划推导
// ============================================================================

/**
 * 从 ref 映射计划推导传输需求
 *
 * 此函数在纯映射计划基础上补入"对象完整性"维度：
 * - 如果本地 hash 与远端相同但对象缺失 → 仍需要 want（对象被 prune 或部分 clone）
 * - 如果 hash 不同 → 正常 want
 * - 如果 wants 为空但指定了 depth → 特殊 deepen 场景，以 matchedRemoteRefs 作为 wants
 *
 * @param plan - 纯 ref 映射计划
 * @param objects - 对象存储（用于校验对象存在性）
 * @param options - 可选配置（如 depth）
 * @returns 传输计划（wants + 执行信号）
 *
 * @example
 * ```ts
 * const plan = planRefUpdates(remoteRefs, localRefs, rules);
 * const transferPlan = resolveFetchWants(plan, objects, { depth: 1 });
 * if (transferPlan.needsPackNegotiation) {
 *   const result = await fetchPack(objects, { wants: transferPlan.wants, ... });
 * }
 * ```
 */
export function resolveFetchWants(
  plan: RefUpdatePlan,
  objects: ObjectSource,
  options?: ResolveFetchWantsOptions,
): FetchTransferPlan {
  const wants = collectWants(plan, objects, options);

  return {
    wants,
    needsPackNegotiation: wants.length > 0,
  };
}

// ============================================================================
// 内部辅助
// ============================================================================

/**
 * 收集 wants
 *
 * 分两步：
 * 1. 正常 wants：从 update items 中收集，包含对象完整性补正
 * 2. 如果 1 为空且指定了 depth → deepen 模式，以 matchedRemoteRefs 作为 wants
 */
function collectWants(
  plan: RefUpdatePlan,
  objects: ObjectSource,
  options?: ResolveFetchWantsOptions,
): SHA1[] {
  const wants: SHA1[] = [];
  const seen = new Set<SHA1>();

  for (const item of plan.updates) {
    const hash = item.remoteRef.hash;

    // 去重
    if (seen.has(hash)) continue;
    seen.add(hash);

    // hash 不同 → 正常 want
    if (item.currentLocalHash !== hash) {
      wants.push(hash);
      continue;
    }

    // hash 相同但对象缺失 → 补正 want（仓库不完整场景）
    if (!objects.exists(hash)) {
      wants.push(hash);
    }
  }

  // Deepen 模式：所有 wants 为空但指定了 depth 时，
  // 以 matchedRemoteRefs 作为 wants 触发服务端 re-negotiation
  if (wants.length === 0 && options?.depth !== undefined) {
    for (const ref of plan.matchedRemoteRefs) {
      if (!seen.has(ref.hash)) {
        wants.push(ref.hash);
      }
    }
  }

  return wants;
}
