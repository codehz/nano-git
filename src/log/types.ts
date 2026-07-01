/**
 * 提交日志遍历类型定义
 *
 * 提供程序化的 git-log 风格接口，不涉及 CLI 参数解析。
 * 调用方负责将 ref 名称解析为 SHA1 哈希后传入。
 *
 * @example
 * ```ts
 * import { walkLogEntries } from "nano-git/log";
 * import { resolveRefHash } from "nano-git/refs/resolve";
 *
 * const headHash = resolveRefHash(repo.refs, "HEAD");
 * if (headHash) {
 *   for (const entry of walkLogEntries(repo.objects, { from: [headHash] })) {
 *     console.log(entry.hash, entry.commit.message);
 *   }
 * }
 * ```
 */

import type { GitCommit, SHA1 } from "../core/types.ts";
import type { MidxBitmapAssist } from "../pack/midx-bitmap.ts";

/** 单条提交日志条目 */
export interface LogEntry {
  /** 提交哈希 */
  readonly hash: SHA1;
  /** 解码后的提交对象 */
  readonly commit: GitCommit;
}

/** 提交遍历排序策略 */
export type CommitWalkOrder = "date" | "topo";

/** 日志遍历选项 */
export interface LogWalkOptions {
  /**
   * 遍历起点哈希列表。
   *
   * 为空时立即返回空结果。
   * 调用方应自行将 ref 名称（如 HEAD、branch names）解析为 SHA1。
   */
  readonly from?: SHA1[];

  /**
   * 排除哈希列表（及其所有祖先）。
   *
   * 等价于 `git log <from> ^<exclude>` 或 `<exclude>..<from>` 范围语法。
   * 被排除的提交及其全部祖先不会出现在结果中。
   */
  readonly exclude?: SHA1[];

  /**
   * 最多输出的提交数量。
   *
   * 等价于 `git log --max-count=<n>`。
   */
  readonly maxCount?: number;

  /**
   * 跳过开头 N 个提交再输出。
   *
   * 等价于 `git log --skip=<n>`。
   */
  readonly skip?: number;

  /**
   * 提交排序策略。
   *
   * - `"date"`（默认）：按提交时间降序。时间相同时不保证严格拓扑序，
   *   但在实践中 parent 的 timestamp 通常 ≤ child，结果与 git log 默认一致。
   * - `"topo"`：严格拓扑排序，所有子提交在父提交之前输出。
   *   同层级的提交按时间戳降序。需要预先收集全部提交，额外开销较大。
   */
  readonly order?: CommitWalkOrder;

  /**
   * 仅输出此 Unix 时间戳（含）之后的提交。
   *
   * 等价于 `git log --since=<timestamp>`。
   */
  readonly since?: number;

  /**
   * 仅输出此 Unix 时间戳（含）之前的提交。
   *
   * 等价于 `git log --until=<timestamp>`。
   */
  readonly until?: number;

  /**
   * 仅沿第一条父链行走。
   *
   * 启用后只追踪每个提交的第一个 parent，忽略 merge 的其他分支。
   * 等价于 `git log --first-parent`。
   */
  readonly firstParent?: boolean;

  /**
   * 链顶 MIDX reachability bitmap，用于加速 `exclude` 祖先标记。
   *
   * 无对应 bitmap 条目时自动回退为逐 parent 遍历。
   */
  readonly bitmapAssist?: MidxBitmapAssist;
}
