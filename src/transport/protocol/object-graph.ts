/**
 * 对象图算法（纯 ObjectStore 版本）
 *
 * 提供 commit ancestry / peel / reachability 等图算法基础设施，
 * 供 fetch 和 push 等上层模块共同依赖，避免基础算法挂在场景编排模块中。
 *
 * @example
 * ```ts
 * import { isAncestor, collectReachable } from "./object-graph.ts";
 *
 * const reachable = collectReachable(store, [headHash]);
 * const isFF = isAncestor(store, oldTip, newTip);
 * ```
 */

import { ObjectNotFoundError } from "../../core/errors.ts";

import type { SHA1 } from "../../core/types.ts";
import type { ObjectStore } from "../../odb/types.ts";

// ============================================================================
// 可达性遍历
// ============================================================================

/** collectReachable 遇到缺失对象时的策略 */
export type CollectReachableMissing = "throw" | "skip" | "skip-commit-parents";

function throwIfMissingObject(
  objects: ObjectStore,
  hash: SHA1,
  missing: CollectReachableMissing,
  viaCommitParent: boolean,
  shallowBoundaries?: Set<SHA1>,
): void {
  // commit parent 缺失且在边界集合中（shallow 或远端 ref 当前 tip）时静默跳过
  if (viaCommitParent && shallowBoundaries?.has(hash)) {
    return;
  }

  // "skip-commit-parents"：非 commit-parent 边的缺失仍视为本地损坏
  const shouldThrow = missing === "throw" || missing === "skip-commit-parents";

  if (shouldThrow) {
    throw new ObjectNotFoundError(
      hash,
      `Object ${hash} is missing from the local store. ` +
        `The local repository may be incomplete or corrupted.`,
    );
  }
}

/**
 * 从指定哈希出发，递归收集所有可达对象哈希
 *
 * @param objects - 对象存储
 * @param hash - 起始对象哈希
 * @param reachable - 用于收集结果的可达集合
 * @param missing - 遇到缺失对象时的行为：
 *   - `"skip"`（默认）：静默跳过，用于远程排除计算
 *   - `"throw"`：任意缺失均抛出错误
 *   - `"skip-commit-parents"`：仅沿 commit parent 边缺失时跳过（shallow 场景）
 * @param viaCommitParent - 当前边是否来自 commit 的 parent 引用
 */
function collectReachableFrom(
  objects: ObjectStore,
  hash: SHA1,
  reachable: Set<SHA1>,
  missing: CollectReachableMissing = "skip",
  shallowBoundaries?: Set<SHA1>,
  viaCommitParent = false,
): void {
  if (reachable.has(hash)) {
    return;
  }

  const obj = objects.tryRead(hash);
  if (obj === undefined) {
    throwIfMissingObject(objects, hash, missing, viaCommitParent, shallowBoundaries);
    return;
  }

  reachable.add(hash);

  switch (obj.type) {
    case "blob":
      return;
    case "tree":
      for (const entry of obj.entries) {
        collectReachableFrom(objects, entry.hash, reachable, missing, shallowBoundaries, false);
      }
      return;
    case "commit":
      collectReachableFrom(objects, obj.tree, reachable, missing, shallowBoundaries, false);
      for (const parent of obj.parents) {
        collectReachableFrom(objects, parent, reachable, missing, shallowBoundaries, true);
      }
      return;
    case "tag":
      collectReachableFrom(objects, obj.object, reachable, missing, shallowBoundaries, false);
      return;
  }
}

/**
 * 从多个起始点收集所有可达对象哈希
 *
 * @param objects - 对象存储
 * @param roots - 起始哈希列表
 * @param missing - 遇到缺失对象时的行为，透传给 collectReachableFrom
 * @param shallowBoundaries - 已知 shallow 边界集合（可选）
 * @returns 可达对象哈希集合
 *
 * @example
 * ```ts
 * const reachable = collectReachable(store, [headHash]);
 * console.log(reachable.size);
 * ```
 */
export function collectReachable(
  objects: ObjectStore,
  roots: SHA1[],
  missing: CollectReachableMissing = "skip",
  shallowBoundaries?: Set<SHA1>,
): Set<SHA1> {
  const reachable = new Set<SHA1>();
  for (const hash of roots) {
    collectReachableFrom(objects, hash, reachable, missing, shallowBoundaries, false);
  }
  return reachable;
}

// ============================================================================
// Tag 链解引用
// ============================================================================

/**
 * 沿 tag 链解引用到最底层的非 tag 对象
 *
 * 遍历 tag → object → 直到遇到非 tag 对象（commit/tree/blob）。
 * 用于 fast-forward 预检：refs/{heads,tags} 之外的命名空间
 * （如 refs/custom/*）允许存储 tag 对象，解引用后才能正确比较祖先关系。
 *
 * @param store - 对象存储
 * @param hash - 起点哈希
 * @param shallowBoundaries - 已知 shallow 边界集合（可选）
 * @returns 解引用后的非 tag 对象哈希，若对象缺失返回 hash 本身
 *
 * @example
 * ```ts
 * const peeled = peelTagChain(store, tagHash);
 * ```
 */
export function peelTagChain(store: ObjectStore, hash: SHA1, shallowBoundaries?: Set<SHA1>): SHA1 {
  let current = hash;

  while (true) {
    const obj = store.tryRead(current);
    if (obj === undefined) {
      // shallow 边界：对象确实可能在本地不存在，返回当前 hash 让调用方处理
      if (shallowBoundaries?.has(current)) {
        return current;
      }
      return current;
    }

    if (obj.type !== "tag") {
      return current;
    }
    current = obj.object;
  }
}

// ============================================================================
// 祖先判断
// ============================================================================

/**
 * 检查 oldHash 是否为 newHash 的祖先 commit（或二者相等）
 *
 * 从 newHash 出发沿 parent 链回溯，若能找到 oldHash 则返回 true。
 * 支持 tag 对象解引用：非 refs/{heads,tags} 命名空间允许存储 tag 对象，
 * 比较时将 oldHash 和 newHash 沿 tag 链解引用到最底层对象（应为 commit）。
 *
 * @param store - 对象存储
 * @param oldHash - 旧的（远端）对象哈希
 * @param newHash - 新的（本地）目标对象哈希
 * @param shallowBoundaries - 已知 shallow 边界集合（可选）
 * @returns oldHash 是否为 newHash 的祖先
 *
 * @example
 * ```ts
 * if (isAncestor(store, oldTip, newTip)) {
 *   console.log("Fast-forward possible");
 * }
 * ```
 */
export function isAncestor(
  store: ObjectStore,
  oldHash: SHA1,
  newHash: SHA1,
  shallowBoundaries?: Set<SHA1>,
): boolean {
  // 相同哈希 trivially 是 fast-forward
  if (oldHash === newHash) {
    return true;
  }

  // 对 tag 对象解引用到最底层对象，使得自定义命名空间（如 refs/custom/*）
  // 中存储的 annotated tag 也能正确进行祖先比较
  const peeledOld = peelTagChain(store, oldHash, shallowBoundaries);
  const peeledNew = peelTagChain(store, newHash, shallowBoundaries);

  // 解引用后相同则是 fast-forward
  if (peeledOld === peeledNew) {
    return true;
  }

  // 将可达性遍历限制在 commit 链上
  const visited = new Set<SHA1>();
  const queue: SHA1[] = [peeledNew];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current === peeledOld) {
      return true;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    // 对象缺失的处理：先检查是否为已知边界（shallow 或远端已广告的 tip）
    const obj = store.tryRead(current);
    if (obj === undefined) {
      // 回溯命中 remote old tip（peeledOld）即 fast-forward
      if (current === peeledOld) {
        return true;
      }
      // 如果缺失哈希在边界集合中，无法继续确认祖先链，假定为 fast-forward 让服务端判定
      if (shallowBoundaries?.has(current)) {
        return true;
      }
      // 其余缺失对象无法证明祖先关系
      return false;
    }

    if (obj.type !== "commit") {
      // 遍历中遇到非 commit 对象（tree/blob/tag），不继续沿此路径回溯
      continue;
    }

    for (const parent of obj.parents) {
      if (!visited.has(parent)) {
        queue.push(parent);
      }
    }
  }

  return false;
}
