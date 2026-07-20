/**
 * 仓库维护操作类型定义
 */

import type { RepositoryGCOptions, RepositoryRepackOptions } from "../../backend/types.ts";
import type { PackBuildResult } from "../../pack/builder/pack-builder.ts";
import type { SHA1 } from "../../types/index.ts";
import type { RewriteHistoryOptions, RewriteHistoryResult } from "./rewrite-types.ts";

export type { RewriteHistoryOptions, RewriteHistoryResult } from "./rewrite-types.ts";

/**
 * 仓库维护相关操作
 */
export interface RepositoryMaintenanceOperations {
  /**
   * 将指定对象写入新的 packfile
   *
   * 未提供哈希列表时，默认打包仓库当前可见的全部对象。
   */
  writePack(hashes?: SHA1[]): PackBuildResult;

  /**
   * 重写仓库 pack 布局
   *
   * 默认行为：
   * - 打包当前可见的全部对象
   * - 删除旧 pack 文件
   * - 保留 loose objects
   */
  repack(options?: RepositoryRepackOptions): PackBuildResult;

  /**
   * 列出从 HEAD、所有分支和所有标签可达的对象
   */
  listReachableObjects(): SHA1[];

  /**
   * 执行基于可达对象的 gc
   *
   * 默认行为：
   * - 只保留从 HEAD、分支、标签可达的对象
   * - 如果有 pack 支持：删除旧 pack 文件，创建包含可达对象的新 pack
   * - 如果没有 pack 支持（如内存仓库）：只删除不可达对象
   *
   * @returns 有 pack 支持时返回新 pack 的构建结果，否则返回 undefined
   */
  gc(options?: RepositoryGCOptions): PackBuildResult | undefined;

  /**
   * 重写历史以修复 unsorted tree（treeNotSorted）
   *
   * 从 HEAD / 分支 / 标签出发，规范化 tree 条目排序，并重写受影响的
   * commit / annotated tag / ref tip。默认保留旧对象；可选 pruneUnreachable
   * 复用 gc 清理不可达对象。带 gpgsig/mergetag 的对象会剥离签名并报告。
   *
   * @example
   * ```ts
   * using repo = createSqliteRepository(".drafts/test.db");
   * const result = repo.rewriteHistory();
   * console.log(result.rewrittenTrees, result.updatedRefs);
   * // tip 哈希已变，push 远端通常需要 force
   * await repo.push(url, { auth, force: true, refSpecs: ["+refs/heads/main:refs/heads/main"] });
   * ```
   */
  rewriteHistory(options?: RewriteHistoryOptions): RewriteHistoryResult;
}
