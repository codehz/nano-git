/**
 * 仓库 Fetch 操作类型定义
 *
 * 定义仓库级别的 remote-oriented fetch 操作接口。
 *
 * fetchRemote() 只更新 remote-tracking refs，不创建本地分支，不修改 HEAD。
 * bootstrapRemote() 是唯一会创建本地分支和设置 HEAD 的入口。
 */

import type {
  RemoteConfig,
  FetchRemoteOptions,
  FetchRemoteResult,
  BootstrapRemoteOptions,
  BootstrapRemoteResult,
} from "./remote-types.ts";

/**
 * 仓库 remote fetch 相关操作
 *
 * fetchRemote() 只更新 remote-tracking refs，不创建本地分支，不修改 HEAD。
 * bootstrapRemote() 是唯一会创建本地分支和设置 HEAD 的入口。
 */
export interface RepositoryFetchOperations {
  /**
   * 添加 remote 配置
   */
  addRemote(config: RemoteConfig): void;

  /**
   * 获取 remote 配置
   */
  getRemote(name: string): RemoteConfig | null;

  /**
   * 列出所有 remote 名称
   */
  listRemotes(): string[];

  /**
   * 从已配置的 remote 拉取对象和更新 remote-tracking refs
   *
   * 等价于 `git fetch <remote>`。
   * 只更新 remote-tracking refs（如 refs/remotes/origin/*），
   * 不创建本地分支，不修改 HEAD。
   *
   * @param name - remote 名称（如 "origin"）
   * @param options - 可选配置（depth、token 等）
   * @returns fetch 操作结果
   *
   * @example
   * ```ts
   * const result = await repo.fetchRemote("origin");
   * console.log(`Fetched ${result.transfer.objectCount} objects`);
   * console.log(`Updated ${result.refUpdates.updatedRefs.size} refs`);
   * ```
   */
  fetchRemote(name: string, options?: FetchRemoteOptions): Promise<FetchRemoteResult>;

  /**
   * 从 remote 拉取并创建本地分支和 HEAD
   *
   * 等价于 `git clone <url>` 的完整流程（但使用已配置的 remote）。
   * 先执行 fetchRemote()，然后根据远端默认分支：
   * - 创建 refs/heads/<branch>
   * - 设置 HEAD -> refs/heads/<branch>
   *
   * 这是唯一会创建本地分支和设置 HEAD 的 API。
   *
   * @param name - remote 名称（如 "origin"）
   * @param options - 可选配置（depth、token、branch 等）
   * @returns bootstrap 操作结果
   *
   * @example
   * ```ts
   * const result = await repo.bootstrapRemote("origin");
   * console.log(`Local branch: ${result.localBranch}`);
   * ```
   */
  bootstrapRemote(name: string, options?: BootstrapRemoteOptions): Promise<BootstrapRemoteResult>;
}
