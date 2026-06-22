/**
 * 仓库 Remote 操作类型定义
 *
 * 定义仓库级别的 remote 配置与 push 操作接口。
 * Remote 只存在于 repository 层，transport 层不感知 remote 实体。
 *
 * 结果类型为 repository 自有语义，不直接复用 transport 层传输类型。
 * 哈希字段使用 SHA1 branded type 保证类型安全。
 */

import type { SHA1 } from "../core/types.ts";

// ============================================================================
// Remote 配置
// ============================================================================

/**
 * Remote 配置
 *
 * 文件后端会将其持久化到 `.git/config` 的 `[remote "<name>"]` section。
 * pushUrl 和 pushRefSpecs 用于支持 pushRemote 的默认行为。
 */
export interface RemoteConfig {
  readonly name: string;

  /** remote 主 URL，也作为 pushUrl 的默认值 */
  readonly url: string;

  /** push 用的 remote URL，不指定时复用 url */
  readonly pushUrl?: string;

  /** push 默认 refspec，如 ["refs/heads/main:refs/heads/main"] */
  readonly pushRefSpecs?: string[];
}

// ============================================================================
// 拒绝项类型（repository 自有语义）
// ============================================================================

// ============================================================================
// Push Remote 操作
// ============================================================================

/**
 * Push remote 操作选项
 *
 * 纯 push 行为参数，不包含传输层细节。
 *
 * 认证：支持 token/headers 透传到 transport。
 * 边界：pushShallowBoundaries 是 repository 层语义（不是 transport 泄漏），优先级高于 backend.shallow。
 */
export interface PushRemoteOptions {
  /**
   * 显式指定要推送的 remote 目标 URL。
   * 不指定时优先使用 RemoteConfig.pushUrl，其次使用 RemoteConfig.url。
   */
  readonly pushUrl?: string;

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
 * Push remote 操作结果（repository 自有语义）
 */
export interface PushRemoteResult {
  /** 已更新的引用列表 */
  readonly pushedRefs: readonly PushRefUpdateResult[];
  /** 推送的对象数量 */
  readonly objectCount: number;
  /** 服务端返回的进度消息 */
  readonly progress: readonly string[];
}

// ============================================================================
// Repository Remote 操作接口
// ============================================================================

/**
 * 仓库 remote 相关操作
 *
 * 统一提供 remote 配置管理与 push 入口。
 */
export interface RepositoryRemoteOperations {
  /** 添加 remote 配置 */
  addRemote(config: RemoteConfig): void;
  /** 获取 remote 配置 */
  getRemote(name: string): RemoteConfig | null;
  /** 列出所有 remote 名称 */
  listRemotes(): string[];

  /**
   * 推送到已配置的 remote
   *
   * 等价于 `git push <remote>`。
   * 默认使用 remote 的 pushUrl（或 url）和 pushRefSpecs。
   */
  pushRemote(name: string, options?: PushRemoteOptions): Promise<PushRemoteResult>;

  /**
   * 推送到远程仓库（不依赖 remote 配置的快捷入口）
   *
   * 等价于 `git push <url>`。
   * 如果已有 remote 配置，建议使用 pushRemote() 以获得更完整的行为。
   */
  push(url: string, options?: PushRemoteOptions): Promise<PushRemoteResult>;
}
