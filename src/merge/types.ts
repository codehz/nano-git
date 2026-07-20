/**
 * merge 模块类型定义
 *
 * 提供 merge-base、三方 tree 合并计划与交互式会话的共享类型。
 */

import type { SHA1 } from "../types/index.ts";

// ============================================================================
// merge-base
// ============================================================================

/**
 * 多 merge-base 处理策略
 *
 * - `"throw"`（默认）：抛出 `MergeBaseError`
 * - `"pick-newest"`：取 committer.timestamp 最大者；并列时按 hash 字典序
 * - `"first"`：返回 independent bases 列表第一项（仅测试/明确降级）
 */
export type MergeBaseMultipleStrategy = "throw" | "pick-newest" | "first";

/**
 * `findMergeBase` 选项
 */
export interface FindMergeBaseOptions {
  /**
   * 多个 independent merge base 时的策略
   *
   * @default "throw"
   */
  readonly onMultiple?: MergeBaseMultipleStrategy;
}

// ============================================================================
// 三方合并 plan
// ============================================================================

/**
 * 合并计划状态
 *
 * - `already-up-to-date`：ours 已包含 theirs 的变更（结果 = ours）
 * - `fast-forward`：base==ours 且 ours!=theirs（结果 = theirs）
 * - `clean`：无冲突，可自动合并（可能需 finalize 写新 tree）
 * - `conflicted`：存在未决议冲突
 */
export type MergePlanStatus = "already-up-to-date" | "fast-forward" | "clean" | "conflicted";

/**
 * 合并条目的对象种类
 */
export type MergeObjectKind = "blob" | "tree" | "symlink";

/**
 * 合并中某一侧的条目快照
 */
export interface MergeSide {
  /** Git 文件模式 */
  readonly mode: string;
  /** 对象哈希 */
  readonly hash: SHA1;
  /** 条目种类 */
  readonly kind: MergeObjectKind;
}

/**
 * 冲突原因
 */
export type MergeConflictReason =
  | "both-modified"
  | "modify-delete"
  | "add-add"
  | "type-change"
  | "mode-conflict";

/**
 * 单条路径冲突
 */
export interface MergeConflict {
  /** 冲突路径（相对 tree 根） */
  readonly path: string;
  /** 冲突原因 */
  readonly reason: MergeConflictReason;
  /** base 侧；缺失时为 null */
  readonly base: MergeSide | null;
  /** ours 侧；缺失时为 null */
  readonly ours: MergeSide | null;
  /** theirs 侧；缺失时为 null */
  readonly theirs: MergeSide | null;
}

/**
 * 已自动决议的路径条目
 *
 * 目录级条目表示整棵子树可直接复用该 hash，无需展开。
 */
export interface MergedPathEntry {
  /** 路径（相对 tree 根；根目录用 "" 表示整树复用） */
  readonly path: string;
  /** 结果 mode */
  readonly mode: string;
  /** 结果 hash */
  readonly hash: SHA1;
  /** 结果种类 */
  readonly kind: MergeObjectKind;
}

/**
 * 三方合并计划（纯数据结构，plan 阶段不写 ODB）
 */
export interface MergePlan {
  /** 合并状态 */
  readonly status: MergePlanStatus;
  /**
   * 若结果已是 ODB 中现成 tree（FF / up-to-date / 整树复用某侧），直接给出；
   * 否则为 null，需 session.finalize() 写入。
   */
  readonly resultTree: SHA1 | null;
  /** base tree 哈希 */
  readonly baseTree: SHA1;
  /** ours tree 哈希 */
  readonly oursTree: SHA1;
  /** theirs tree 哈希 */
  readonly theirsTree: SHA1;
  /** 已自动决议的路径（含压缩的目录级 entry） */
  readonly autoEntries: readonly MergedPathEntry[];
  /** 冲突列表 */
  readonly conflicts: readonly MergeConflict[];
  /**
   * 实际使用的 base commit 列表（commit 级 API 填充；tree 级为空数组）
   */
  readonly bases: readonly SHA1[];
  /** ours commit（若由 planCommitMerge 产生） */
  readonly oursCommit?: SHA1;
  /** theirs commit（若由 planCommitMerge 产生） */
  readonly theirsCommit?: SHA1;
}

/**
 * `planTreeMerge` 输入
 */
export interface PlanTreeMergeInput {
  readonly baseTree: SHA1;
  readonly oursTree: SHA1;
  readonly theirsTree: SHA1;
}

/**
 * `planCommitMerge` 输入
 */
export interface PlanCommitMergeInput {
  readonly ours: SHA1;
  readonly theirs: SHA1;
  /** 显式 base commit；省略时自动 findMergeBase */
  readonly base?: SHA1;
  /** 多 base 策略，默认 throw */
  readonly onMultipleBase?: MergeBaseMultipleStrategy;
}

// ============================================================================
// 交互会话
// ============================================================================

/**
 * 冲突 / 覆盖路径的决议
 *
 * - `ours` / `theirs` / `base`：取对应侧（base 在该侧为 null 时非法）
 * - `custom` + hash：使用已有对象
 * - `custom` + content：session 写入新 blob
 */
export type MergeDecision =
  | { readonly take: "ours" | "theirs" | "base" }
  | { readonly take: "custom"; readonly mode: string; readonly hash: SHA1 }
  | { readonly take: "custom"; readonly mode: string; readonly content: Buffer };

/**
 * 批量决议条目
 */
export interface MergePathDecision {
  readonly path: string;
  readonly decision: MergeDecision;
}

/**
 * finalize 结果
 */
export interface MergeFinalizeResult {
  /** 合并后的根 tree 哈希 */
  readonly tree: SHA1;
  /** 本次新写入的 tree 哈希列表 */
  readonly writtenTrees: readonly SHA1[];
}

/**
 * 交互式 merge 会话
 */
export interface MergeSession {
  /** 底层 plan（只读快照） */
  readonly plan: MergePlan;
  /** 列出仍未决议的冲突 */
  listConflicts(): readonly MergeConflict[];
  /** 决议单条路径 */
  resolve(path: string, decision: MergeDecision): void;
  /** 批量决议 */
  resolveMany(decisions: readonly MergePathDecision[]): void;
  /** 撤销某路径决议（回到冲突态或自动态） */
  unresolve(path: string): void;
  /** 是否所有冲突均已决议 */
  isComplete(): boolean;
  /**
   * 写入最终 tree
   *
   * @throws UnresolvedConflictsError 若仍有未决议冲突
   */
  finalize(): MergeFinalizeResult;
}
