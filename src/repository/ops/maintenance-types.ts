/**
 * 核心仓库维护操作类型定义
 */

import type { RepositoryGCOptions } from "../../backend/types.ts";
import type { SHA1 } from "../../types/index.ts";
import type { RewriteHistoryOptions, RewriteHistoryResult } from "./rewrite-types.ts";

export type { RewriteHistoryOptions, RewriteHistoryResult } from "./rewrite-types.ts";

/**
 * 不依赖 pack 的仓库维护操作
 */
export interface RepositoryMaintenanceOperations {
  /** 列出从 HEAD、所有分支和所有标签可达的对象 */
  listReachableObjects(): SHA1[];

  /**
   * 执行基于可达对象的核心 GC
   *
   * 只清理不可达对象，不执行 packfile repack。
   */
  gc(options?: RepositoryGCOptions): void;

  /**
   * 重写历史以修复 unsorted tree（treeNotSorted）
   *
   * 从 HEAD / 分支 / 标签出发，规范化 tree 条目排序，并重写受影响的
   * commit / annotated tag / ref tip。默认保留旧对象；可选 pruneUnreachable
   * 清理不可达对象。带 gpgsig/mergetag 的对象会剥离签名并报告。
   */
  rewriteHistory(options?: RewriteHistoryOptions): RewriteHistoryResult;
}
