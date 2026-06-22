/**
 * 仓库 push 操作类型定义
 *
 * repository 层只保留显式 URL 的 push 入口。
 * 结果类型为 repository 自有语义，不直接复用 transport 层传输类型。
 * 哈希字段使用 SHA1 branded type 保证类型安全。
 */

import type { SHA1 } from "../core/types.ts";

/**
 * 远端配置
 *
 * 仅供底层后端与兼容性存储使用，不属于 repository 主 API。
 */
export interface RemoteConfig {
  readonly name: string;
  readonly url: string;
  readonly pushUrl?: string;
  readonly pushRefSpecs?: string[];
}

/**
 * 仓库 push 操作选项
 *
 * 纯 push 行为参数，不包含传输层细节。
 *
 * 认证：支持 token/headers 透传到 transport。
 * 边界：pushShallowBoundaries 是 repository 层语义（不是 transport 泄漏），优先级高于 backend.shallow。
 */
export interface RepositoryPushOptions {
  /**
   * refspec 列表，格式如 "refs/heads/main:refs/heads/main"
   * 默认为将当前分支推送到远端同名分支（等价于 `git push <url>`）
   */
  readonly refSpecs?: string[];

  /** 是否强制推送（--force），等价于 refspec 的 + 前缀 */
  readonly force?: boolean;

  /** 认证 token（用于 bearer 或 basic auth），由 repository 层透传 */
  readonly token?: string;

  /** 自定义请求头，由 repository 层透传 */
  readonly headers?: Record<string, string>;

  /**
   * 推送时已知的浅克隆边界（repository 层 override，非 transport 泄漏）。
   * - 传入（含空数组 `[]`）即覆盖 `backend.shallow`，不再回退
   * - 传 `[]` 表示显式不使用 backend.shallow 中的边界
   * - 不传（`undefined`）才回退 `backend.shallow.read()`
   */
  readonly pushShallowBoundaries?: SHA1[];
}

/**
 * 单条引用更新结果（repository 自有语义）
 */
export interface PushRefUpdateResult {
  /** 引用名称，如 "refs/heads/main" */
  readonly refName: string;
  /** 更新前的哈希（服务端原有值） */
  readonly oldHash: SHA1 | null;
  /** 更新后的哈希 */
  readonly newHash: SHA1 | null;
  /** 是否成功 */
  readonly success: boolean;
  /** 失败时的错误消息 */
  readonly error?: string;
  /** 是否强制更新 */
  readonly forced: boolean;
}

/**
 * 仓库 push 操作结果（repository 自有语义）
 */
export interface RepositoryPushResult {
  /** 已更新的引用列表 */
  readonly pushedRefs: readonly PushRefUpdateResult[];
  /** 推送的对象数量 */
  readonly objectCount: number;
  /** 服务端返回的进度消息 */
  readonly progress: readonly string[];
}

/**
 * 仓库 push 操作接口
 */
export interface RepositoryPushOperations {
  /**
   * 推送到远程仓库
   *
   * 等价于 `git push <url>`。
   */
  push(url: string, options?: RepositoryPushOptions): Promise<RepositoryPushResult>;
}
