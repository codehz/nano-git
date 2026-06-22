/**
 * 仓库 Push 操作类型定义
 *
 * 定义仓库级别的 remote-oriented push 操作接口。
 *
 * pushRemote() 走 repository 语义（读取 remote 配置、pushUrl、pushRefSpecs），
 * push(url) 走 ad-hoc 语义（不依赖 remote 配置的直接推送）。
 * 两者最终复用同一个内部编排函数。
 */

import type { PushOptions, PushResult } from "../transport/types.ts";

// ============================================================================
// Push 操作选项
// ============================================================================

/**
 * Push remote 操作选项
 *
 * 继承 PushOptions，增加 remote 层次的控制参数。
 */
export interface PushRemoteOptions extends PushOptions {
  /**
   * 显式指定要推送的 remote 目标 URL。
   * 不指定时优先使用 RemoteConfig.pushUrl，其次使用 RemoteConfig.url。
   */
  readonly pushUrl?: string;
}

/**
 * Push remote 操作结果
 *
 * 当前与 PushResult 一致，预留后续扩展字段空间。
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PushRemoteResult extends PushResult {}

// ============================================================================
// Repository Push 操作接口
// ============================================================================

/**
 * 仓库 push 相关操作
 *
 * 提供两层 API：
 * - pushRemote(name, options)：基于 remote 配置的推送（主语义）
 * - push(url, options)：不依赖 remote 配置的快捷推送
 */
export interface RepositoryPushOperations {
  /**
   * 推送到已配置的 remote
   *
   * 等价于 `git push <remote>`。
   * 默认使用 remote 的 pushUrl（或 url）和 pushRefSpecs。
   *
   * @param name - remote 名称（如 "origin"）
   * @param options - 可选配置（refSpecs、token、force 等）
   * @returns push 操作结果
   *
   * @example
   * ```ts
   * // 使用 remote 的默认配置推送
   * const result = await repo.pushRemote("origin");
   *
   * // 覆盖 refspec
   * const result = await repo.pushRemote("origin", {
   *   refSpecs: ["refs/heads/main:refs/heads/main"],
   * });
   *
   * // 强制推送
   * const result = await repo.pushRemote("origin", { force: true });
   * ```
   */
  pushRemote(name: string, options?: PushRemoteOptions): Promise<PushRemoteResult>;

  /**
   * 推送到远程仓库（不依赖 remote 配置的快捷入口）
   *
   * 等价于 `git push <url>`：将当前分支推送到远端同名分支。
   * HEAD 处于 detached 状态时必须通过 options.refSpecs 显式指定 refspec。
   *
   * 这是不依赖 remote 配置的 ad-hoc 推送方式。
   * 如果已有 remote 配置，建议使用 pushRemote() 以获得更完整的行为。
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
