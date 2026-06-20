/**
 * 仓库 Push 操作类型定义
 *
 * 定义仓库级别的 push 操作接口，
 * 允许通过 repo.push() 推送到远程 Git 仓库。
 */

import type { PushOptions, PushResult } from "../transport/types.ts";

/**
 * 仓库 push 相关操作
 *
 * 封装 Smart HTTP 协议，将本地对象推送到远程 Git 仓库。
 */
export interface RepositoryPushOperations {
  /**
   * 推送到远程仓库
   *
   * 等价于 `git push <url>`
   *
   * @param url - 远程仓库 URL（如 "https://github.com/user/repo"）
   * @param options - 可选配置（refspec、token 等）
   * @returns push 操作结果
   *
   * @example
   * ```ts
   * const result = await repo.push("https://github.com/user/repo");
   * console.log(`Pushed ${result.objectCount} objects`);
   * ```
   */
  push(url: string, options?: PushOptions): Promise<PushResult>;
}
