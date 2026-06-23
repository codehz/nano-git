/**
 * Push Pack 规划
 *
 * 处理"我要发送哪些对象"的问题：
 * - 合并 shallow 边界与远端 tip 边界
 * - 计算本地推送 ref 可达且远程缺失的对象差集
 *
 * @example
 * ```ts
 * import { mergePushBoundaries, computeObjectsToSend } from "./push-pack-plan.ts";
 * const boundaries = mergePushBoundaries(shallowSet, pushRefs);
 * const objectsToSend = computeObjectsToSend(store, pushRefs, remoteRefs, boundaries);
 * ```
 */

import { collectReachable } from "../../protocol/object-graph.ts";
import { PushError } from "./push-error.ts";

import type { SHA1 } from "../../../core/types.ts";
import type { ObjectStore } from "../../../odb/types.ts";
import type { PushRefItem } from "./push-ref-plan.ts";

/**
 * 合并 shallow 边界与各推送项的远端当前 tip，供预检与本地可达性遍历使用
 */
export function mergePushBoundaries(
  shallowSet: Set<SHA1> | undefined,
  pushRefs: PushRefItem[],
): Set<SHA1> | undefined {
  const remoteTips = pushRefs
    .map((item) => item.remoteHash)
    .filter((hash): hash is SHA1 => hash !== null);

  if (!shallowSet && remoteTips.length === 0) {
    return undefined;
  }

  const merged = new Set<SHA1>(shallowSet);
  for (const hash of remoteTips) {
    merged.add(hash);
  }
  return merged;
}

/**
 * 计算需要发送到远端的对象集合
 *
 * 需要推送的对象 = 从推送 refs 可达的对象 - 从远程已有 refs 可达的对象
 * 删除操作（localHash === null）跳过对象收集。
 *
 * 本地可达性使用 "skip-commit-parents" 模式让缺失的 commit parent 不阻断遍历，
 * 但 tree/blob/tag 等非 commit-parent 边的缺失仍会抛出 PushError。
 *
 * @param store - 本地对象存储
 * @param pushRefs - 推送引用项列表
 * @param remoteRefs - 远程 ref → hash 映射
 * @param pushBoundaries - 合并后的边界集（可选）
 * @returns 需要发送的对象哈希列表
 * @throws PushError 当本地对象损坏导致无法遍历时
 */
export function computeObjectsToSend(
  store: ObjectStore,
  pushRefs: PushRefItem[],
  remoteRefs: Map<string, SHA1>,
  pushBoundaries: Set<SHA1> | undefined,
): SHA1[] {
  // 收集本地推送 ref 的可达对象
  const localRoots = pushRefs
    .filter((r): r is PushRefItem & { localHash: SHA1 } => r.localHash !== null)
    .map((r) => r.localHash);
  let reachableLocal: Set<SHA1>;
  try {
    reachableLocal = collectReachable(store, localRoots, "skip-commit-parents", pushBoundaries);
  } catch (err: unknown) {
    throw new PushError(err instanceof Error ? err.message : String(err));
  }

  // 收集远程已有 refs 的可达对象（用于排除已存在的对象）
  const remoteRoots: SHA1[] = [];
  for (const [, hash] of remoteRefs) {
    remoteRoots.push(hash);
  }
  const reachableRemote = collectReachable(store, remoteRoots);

  // 计算差集
  const objectsToSend: SHA1[] = [];
  for (const hash of reachableLocal) {
    if (!reachableRemote.has(hash)) {
      objectsToSend.push(hash);
    }
  }

  return objectsToSend;
}
