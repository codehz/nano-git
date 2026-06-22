/**
 * 仓库 Remote 操作类型定义
 *
 * 定义仓库级别的 remote 配置与 fetch/push 操作接口。
 * Remote 只存在于 repository 层，transport 层不感知 remote 实体。
 *
 * 结果类型为 repository 自有语义，不直接复用 transport 层传输类型。
 */

import type { RefMappingRule } from "../transport/types.ts";
import type { PushOptions } from "../transport/types.ts";

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

  /** fetch 用的 remote URL，也作为 pushUrl 的默认值 */
  readonly url: string;

  /** push 用的 remote URL，不指定时复用 url */
  readonly pushUrl?: string;

  /** fetch 映射规则，如 [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }] */
  readonly fetchRules: RefMappingRule[];

  /** push 默认 refspec，如 ["refs/heads/main:refs/heads/main"] */
  readonly pushRefSpecs?: string[];
}

// ============================================================================
// 拒绝项类型（repository 自有语义）
// ============================================================================

/**
 * Ref 更新拒绝项
 */
export interface RefUpdateRejection {
  readonly localRef: string;
  readonly reason: string;
}

// ============================================================================
// Fetch Remote 操作
// ============================================================================

/**
 * Fetch remote 操作选项
 *
 * fetchRemote 只更新 remote-tracking refs，不创建本地分支，不修改 HEAD。
 */
export interface FetchRemoteOptions {
  readonly depth?: number;
  readonly token?: string;
  readonly headers?: Record<string, string>;
  readonly maxCandidates?: number;
}

/**
 * Fetch remote 操作结果（repository 自有语义）
 *
 * 不直接暴露 transport 层的 FetchPackResult / ApplyRefUpdatesResult，
 * 只暴露仓库层关心的语义字段。
 */
export interface FetchRemoteResult {
  /** 本次获取的对象数量 */
  readonly fetchedObjects: number;
  /** 已更新的 ref 映射（ref 名称 → SHA1） */
  readonly updatedRefs: ReadonlyMap<string, string>;
  /** 被拒绝的 ref 更新列表 */
  readonly rejectedRefs: readonly RefUpdateRejection[];
  /** 远端默认分支（可能为 undefined） */
  readonly defaultBranch?: string;
}

// ============================================================================
// Bootstrap Remote 操作
// ============================================================================

/**
 * Bootstrap remote 操作选项
 */
export interface BootstrapRemoteOptions extends FetchRemoteOptions {
  /** 创建本地分支时使用的名称，不指定则采用远端默认分支名 */
  readonly branch?: string;
}

/**
 * Bootstrap remote 操作结果
 */
export interface BootstrapRemoteResult extends FetchRemoteResult {
  /** 创建的本地分支名 */
  readonly localBranch: string;
}

// ============================================================================
// Push Remote 操作
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
 * 单条引用更新结果（repository 自有语义）
 */
export interface PushRefUpdateResult {
  /** 引用名称，如 "refs/heads/main" */
  readonly refName: string;
  /** 更新前的哈希（服务端原有值） */
  readonly oldHash: string | null;
  /** 更新后的哈希 */
  readonly newHash: string | null;
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
// Repository Remote 操作接口（合并 fetch + push）
// ============================================================================

/**
 * 仓库 remote 相关操作
 *
 * 统一提供 fetch 和 push 的 remote 操作入口。
 */
export interface RepositoryRemoteOperations {
  /** 添加 remote 配置 */
  addRemote(config: RemoteConfig): void;
  /** 获取 remote 配置 */
  getRemote(name: string): RemoteConfig | null;
  /** 列出所有 remote 名称 */
  listRemotes(): string[];

  /**
   * 从已配置的 remote 拉取对象和更新 remote-tracking refs
   *
   * 等价于 `git fetch <remote>`。
   * 只更新 remote-tracking refs（如 refs/remotes/origin/*），
   * 不创建本地分支，不修改 HEAD。
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
   */
  bootstrapRemote(name: string, options?: BootstrapRemoteOptions): Promise<BootstrapRemoteResult>;

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
  push(url: string, options?: PushOptions): Promise<PushRemoteResult>;
}
