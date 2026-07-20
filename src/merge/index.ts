/**
 * nano-git/merge - 基础 merge 算法
 *
 * 提供 merge-base 查找与路径级三方 tree 合并（plan → resolve → finalize）。
 * 不涉及 index / worktree / rename / 行级内容合并。
 *
 * ## 子路径入口
 *
 * | 入口 | 内容 | 依赖 |
 * |------|------|------|
 * | `nano-git/merge` | merge-base + tree 三方合并 + 交互会话 | `node:crypto` |
 *
 * @example
 * ```ts
 * import { findMergeBase, findMergeBases } from "nano-git/merge";
 *
 * const bases = findMergeBases(repo.objects, ours, theirs);
 * const base = findMergeBase(repo.objects, ours, theirs, { onMultiple: "pick-newest" });
 * ```
 */

export { findMergeBase, findMergeBases } from "./merge-base.ts";
export { planTreeMerge, EMPTY_TREE_HASH } from "./three-way.ts";
export { planCommitMerge } from "./commit-merge.ts";
export { createMergeSession } from "./session.ts";
export { buildTreeFromMergedEntries, ensureEmptyTree } from "./build-tree.ts";
export type {
  FindMergeBaseOptions,
  MergeBaseMultipleStrategy,
  MergeConflict,
  MergeConflictReason,
  MergeDecision,
  MergeFinalizeResult,
  MergeObjectKind,
  MergePathDecision,
  MergePlan,
  MergePlanStatus,
  MergeSession,
  MergeSide,
  MergedPathEntry,
  PlanCommitMergeInput,
  PlanTreeMergeInput,
} from "./types.ts";
