/**
 * 仓库维护操作类型定义
 */

import type { SHA1 } from "../core/types.ts";
import type { PackBuildResult } from "../odb/index.ts";
import type { RepositoryGCOptions, RepositoryRepackOptions } from "./backend/index.ts";

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
   * - 删除旧 pack 文件
   * - 删除已打包的 loose objects
   */
  gc(options?: RepositoryGCOptions): PackBuildResult;
}
