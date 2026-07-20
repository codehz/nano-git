/**
 * 基于 commit 的三方合并编排
 *
 * 解析 ours/theirs（及可选 base）commit → merge-base → planTreeMerge。
 * 不创建 merge commit，不更新 ref。
 */

import { MergeBaseError, MergeError } from "../errors.ts";
import { readObject } from "../objects/raw.ts";
import { findMergeBase } from "./merge-base.ts";
import { planTreeMerge } from "./three-way.ts";

import type { ObjectSource } from "../odb/types.ts";
import type { GitCommit, SHA1 } from "../types/index.ts";
import type { MergePlan, PlanCommitMergeInput } from "./types.ts";

/**
 * 读取并校验 commit
 */
function readCommit(source: ObjectSource, hash: SHA1): GitCommit {
  const obj = readObject(source, hash);
  if (obj.type !== "commit") {
    throw new MergeError(`Expected commit object for merge, got '${obj.type}'`, { hash });
  }
  return obj;
}

/**
 * 对两个 commit 做三方合并计划
 *
 * - 未指定 `base` 时调用 `findMergeBase`
 * - 无共同祖先时抛出 `MergeBaseError`
 * - 多 base 策略由 `onMultipleBase` 控制（默认 throw）
 *
 * @param source - 对象源
 * @param input - ours / theirs / 可选 base
 * @returns 带 commit 元数据的 MergePlan
 *
 * @example
 * ```ts
 * const plan = planCommitMerge(repo.objects, { ours: head, theirs: feature });
 * const session = createMergeSession(repo.objects, plan);
 * // ... resolve conflicts ...
 * const { tree } = session.finalize();
 * const mergeCommit = repo.createCommit(tree, [head, feature], "Merge", author);
 * ```
 */
export function planCommitMerge(source: ObjectSource, input: PlanCommitMergeInput): MergePlan {
  const oursCommit = readCommit(source, input.ours);
  const theirsCommit = readCommit(source, input.theirs);

  let baseCommitHash: SHA1;
  if (input.base !== undefined) {
    readCommit(source, input.base);
    baseCommitHash = input.base;
  } else {
    const found = findMergeBase(source, input.ours, input.theirs, {
      onMultiple: input.onMultipleBase ?? "throw",
    });
    if (found === null) {
      throw new MergeBaseError("No common merge base (unrelated histories)", {
        bases: [],
      });
    }
    baseCommitHash = found;
  }

  const baseCommit = readCommit(source, baseCommitHash);
  const treePlan = planTreeMerge(source, {
    baseTree: baseCommit.tree,
    oursTree: oursCommit.tree,
    theirsTree: theirsCommit.tree,
  });

  return {
    ...treePlan,
    bases: [baseCommitHash],
    oursCommit: input.ours,
    theirsCommit: input.theirs,
  };
}
