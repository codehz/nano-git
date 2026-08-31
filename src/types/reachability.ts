/**
 * 可达性算法的可选加速能力
 *
 * 核心图算法只依赖此接口，不依赖具体的 pack 或 MIDX 实现。
 */

import type { SHA1 } from "./index.ts";

/**
 * 将指定 commit 的可达对象加入集合
 */
export interface ReachabilityAccelerator {
  /**
   * 尝试使用预计算索引展开 commit 的可达对象
   *
   * @returns 成功使用加速数据时返回 true，否则由调用方回退遍历
   */
  addReachableFromCommit(commitHash: SHA1, reachable: Set<SHA1>): boolean;
}
