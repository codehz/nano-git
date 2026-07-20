/**
 * merge-base：查找两个 commit 的共同祖先
 *
 * 返回 independent merge bases（共同祖先中去掉「是另一个共同祖先的祖先」的节点）。
 * 不做 recursive virtual merge；多 base 由调用方通过 `onMultiple` 处理。
 */

import { MergeBaseError, MergeError } from "../errors.ts";
import { readObject } from "../objects/raw.ts";

import type { ObjectSource } from "../odb/types.ts";
import type { GitCommit, SHA1 } from "../types/index.ts";
import type { FindMergeBaseOptions, MergeBaseMultipleStrategy } from "./types.ts";

const FLAG_PARENT1 = 1;
const FLAG_PARENT2 = 2;

/**
 * 读取并校验 commit 对象
 */
function readCommit(source: ObjectSource, hash: SHA1): GitCommit {
  const obj = readObject(source, hash);
  if (obj.type !== "commit") {
    throw new MergeBaseError(`Expected commit object for merge-base, got '${obj.type}'`, {
      hash,
    });
  }
  return obj;
}

/**
 * 判断 `ancestor` 是否为 `descendant` 的严格祖先（不含相等）
 */
function isStrictAncestor(source: ObjectSource, ancestor: SHA1, descendant: SHA1): boolean {
  if (ancestor === descendant) {
    return false;
  }

  const visited = new Set<SHA1>();
  const stack: SHA1[] = [descendant];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === ancestor) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const commit = readCommit(source, current);
    for (const parent of commit.parents) {
      if (!visited.has(parent)) {
        stack.push(parent);
      }
    }
  }

  return false;
}

/**
 * 从候选共同祖先中剔除被其他候选支配的节点，得到 independent merge bases
 */
function selectIndependentBases(source: ObjectSource, candidates: readonly SHA1[]): SHA1[] {
  if (candidates.length <= 1) {
    return [...candidates];
  }

  const independent: SHA1[] = [];
  for (const candidate of candidates) {
    let dominated = false;
    for (const other of candidates) {
      if (candidate === other) {
        continue;
      }
      // candidate 是 other 的祖先 → 被支配，非 independent
      if (isStrictAncestor(source, candidate, other)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) {
      independent.push(candidate);
    }
  }

  // 稳定输出：按 hash 字典序
  independent.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return independent;
}

/**
 * 查找两个 commit 的全部 independent merge bases
 *
 * - `a === b` → `[a]`
 * - 无共同祖先 → `[]`
 * - 输入必须是 commit，否则抛出 `MergeBaseError`
 *
 * @param source - 对象源
 * @param a - 第一个 commit
 * @param b - 第二个 commit
 * @returns independent merge base 列表（按 hash 排序）
 *
 * @example
 * ```ts
 * const bases = findMergeBases(repo.objects, ours, theirs);
 * if (bases.length === 1) {
 *   console.log("base:", bases[0]);
 * }
 * ```
 */
export function findMergeBases(source: ObjectSource, a: SHA1, b: SHA1): SHA1[] {
  // 先校验两侧均为 commit
  readCommit(source, a);
  readCommit(source, b);

  if (a === b) {
    return [a];
  }

  const flags = new Map<SHA1, number>();

  // 标记 a 的全部祖先（含自身）为 PARENT1
  {
    const stack: SHA1[] = [a];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const currentFlags = flags.get(current) ?? 0;
      if (currentFlags & FLAG_PARENT1) {
        continue;
      }
      flags.set(current, currentFlags | FLAG_PARENT1);
      const commit = readCommit(source, current);
      for (const parent of commit.parents) {
        stack.push(parent);
      }
    }
  }

  // 从 b 遍历，收集同时带 PARENT1 的节点为共同祖先候选
  const common: SHA1[] = [];
  {
    const stack: SHA1[] = [b];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const currentFlags = flags.get(current) ?? 0;
      if (currentFlags & FLAG_PARENT2) {
        continue;
      }
      flags.set(current, currentFlags | FLAG_PARENT2);
      if (currentFlags & FLAG_PARENT1) {
        common.push(current);
      }
      const commit = readCommit(source, current);
      for (const parent of commit.parents) {
        stack.push(parent);
      }
    }
  }

  return selectIndependentBases(source, common);
}

/**
 * 按策略从多个 base 中选出一个
 */
function pickOneBase(
  source: ObjectSource,
  bases: readonly SHA1[],
  strategy: MergeBaseMultipleStrategy,
): SHA1 {
  if (bases.length === 0) {
    throw new MergeError("pickOneBase called with empty bases");
  }
  if (bases.length === 1 || strategy === "first") {
    return bases[0]!;
  }

  if (strategy === "pick-newest") {
    let best = bases[0]!;
    let bestTs = readCommit(source, best).committer.timestamp;
    for (let i = 1; i < bases.length; i++) {
      const candidate = bases[i]!;
      const ts = readCommit(source, candidate).committer.timestamp;
      if (ts > bestTs || (ts === bestTs && candidate < best)) {
        best = candidate;
        bestTs = ts;
      }
    }
    return best;
  }

  // strategy === "throw"
  throw new MergeBaseError(
    `Multiple independent merge bases found (${bases.length}); ` +
      `pass onMultiple: "pick-newest" or "first" to disambiguate`,
    { bases: [...bases] },
  );
}

/**
 * 查找两个 commit 的单个 merge base
 *
 * - 无共同祖先 → `null`
 * - 恰好一个 → 返回该 base
 * - 多个：由 `options.onMultiple` 决定（默认 `"throw"`）
 *
 * @param source - 对象源
 * @param a - 第一个 commit
 * @param b - 第二个 commit
 * @param options - 多 base 策略等
 * @returns 单个 merge base，或 `null`
 *
 * @example
 * ```ts
 * const base = findMergeBase(repo.objects, ours, theirs);
 * if (base === null) {
 *   throw new Error("unrelated histories");
 * }
 * ```
 */
export function findMergeBase(
  source: ObjectSource,
  a: SHA1,
  b: SHA1,
  options: FindMergeBaseOptions = {},
): SHA1 | null {
  const bases = findMergeBases(source, a, b);
  if (bases.length === 0) {
    return null;
  }
  if (bases.length === 1) {
    return bases[0]!;
  }

  const strategy = options.onMultiple ?? "throw";
  return pickOneBase(source, bases, strategy);
}
