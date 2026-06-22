/**
 * 仓库 Remote 操作类型定义
 *
 * 定义仓库级别的 remote 配置与 fetch 操作接口。
 * Remote 只存在于 repository 层，transport 层不感知 remote 实体。
 */

import type { RefMappingRule, FetchPackResult, ApplyRefUpdatesResult } from "../transport/types.ts";

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
 * Fetch remote 操作结果（阶段化）
 *
 * 将 fetch 过程的结果按阶段分层：
 * - transfer: 对象传输结果（传输了什么）
 * - refUpdates: ref 更新结果（更新了什么、拒绝了什么）
 *
 * 与 applyRefUpdates 的设计方向一致，不丢失 rejectedRefs 等决策信息。
 */
export interface FetchRemoteResult {
  /** 对象传输结果 */
  readonly transfer: FetchPackResult;
  /** ref 更新结果（含被拒绝项） */
  readonly refUpdates: ApplyRefUpdatesResult;
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
