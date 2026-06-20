/**
 * 仓库 Fetch 操作类型定义
 *
 * 定义仓库级别的 fetch 操作接口，
 * 允许通过 repo.fetch() 从远程 Git 仓库拉取对象和引用。
 */

import type { FetchOptions, FetchResult } from "../transport/types.ts";

/**
 * 仓库 fetch 相关操作
 *
 * 封装 Smart HTTP 协议，从远程 Git 仓库拉取对象和引用更新。
 */
export interface RepositoryFetchOperations {
  /**
   * 从远程仓库执行 fetch（clone / fetch）
   *
   * 等价于 `git fetch <url>` 或 `git clone <url>` 的获取阶段。
   *
   * @param url - 远程仓库 URL（如 "https://github.com/user/repo"）
   * @param options - 可选配置（refspec、depth 等）
   * @returns fetch 操作结果
   *
   * @example
   * ```ts
   * const result = await repo.fetch("https://github.com/user/repo");
   * console.log(`Fetched ${result.objectCount} objects`);
   * ```
   */
  fetch(url: string, options?: FetchOptions): Promise<FetchResult>;
}
