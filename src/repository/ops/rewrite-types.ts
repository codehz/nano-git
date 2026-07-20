/**
 * 历史重写（修复异常 tree）类型定义
 *
 * 第一版只做 treeNotSorted 规范化：按 Git 规范重排 tree 条目，
 * 并重写受影响的 commit / annotated tag / ref tip。
 */

import type { ObjectType, SHA1 } from "../../types/index.ts";

/**
 * rewriteHistory 选项
 */
export interface RewriteHistoryOptions {
  /**
   * 仅预览：计算映射与待更新 ref，不写入对象、不修改 refs
   *
   * @default false
   */
  readonly dryRun?: boolean;

  /**
   * 成功写入后是否清理不可达旧对象（复用仓库 gc）
   *
   * dryRun 时忽略。
   *
   * @default false
   */
  readonly pruneUnreachable?: boolean;

  /**
   * 覆盖默认 tip 集合的 ref 列表
   *
   * 未提供时使用 HEAD + refs/heads/* + refs/tags/*。
   * 传入时只处理这些 ref 的解析 tip，并只更新其中的具体（非符号）ref。
   */
  readonly refs?: readonly string[];
}

/**
 * 发生重写的对象映射项（仅 oldHash !== newHash）
 */
export interface RewrittenObject {
  /** 重写前哈希 */
  readonly oldHash: SHA1;
  /** 重写后哈希 */
  readonly newHash: SHA1;
  /** 对象类型 */
  readonly type: ObjectType;
}

/**
 * 被更新的具体引用
 */
export interface UpdatedRef {
  /** 完整引用名，如 "refs/heads/main" */
  readonly ref: string;
  /** 更新前 tip 哈希 */
  readonly oldHash: SHA1;
  /** 更新后 tip 哈希 */
  readonly newHash: SHA1;
}

/**
 * 因重写而剥离的签名信息
 *
 * 重写后 gpgsig / mergetag 必然失效，第一版直接剥离并报告。
 */
export interface DroppedSignature {
  /** 剥离前的对象哈希 */
  readonly hash: SHA1;
  /** 对象类型 */
  readonly type: "commit" | "tag";
  /** 剥离的签名字段 */
  readonly kind: "gpgsig" | "mergetag";
}

/**
 * rewriteHistory 结果
 */
export interface RewriteHistoryResult {
  /** 是否为 dryRun 预览 */
  readonly dryRun: boolean;
  /** 重写的 tree 数量（old≠new） */
  readonly rewrittenTrees: number;
  /** 重写的 commit 数量（old≠new） */
  readonly rewrittenCommits: number;
  /** 重写的 tag 数量（old≠new） */
  readonly rewrittenTags: number;
  /** 对象映射列表（仅 old≠new，序列化友好） */
  readonly objectMap: readonly RewrittenObject[];
  /** 实际（或 dryRun 下将）更新的具体 ref */
  readonly updatedRefs: readonly UpdatedRef[];
  /** 被剥离的签名记录 */
  readonly droppedSignatures: readonly DroppedSignature[];
}
