/**
 * Smart HTTP 传输层类型定义
 *
 * 定义了远程 Git 仓库交互所需的核心类型：
 * - RemoteRef：远程引用信息
 * - RefAdvertisement：服务端引用广告（含能力声明）
 * - FetchOptions：fetch 操作选项
 * - FetchResult：fetch 操作结果
 * - PushOptions：push 操作选项
 * - PushResult：push 操作结果
 * - PushRefUpdate：单条引用更新结果
 */

import type { SHA1 } from "../core/types.ts";

// ============================================================================
// 传输层接口（用于测试注入）
// ============================================================================

/**
 * 远程传输层接口
 *
 * 定义 push/fetch 编排函数所需的远程交互原语。
 * SmartHttpClient（smart-http.ts）实现了此接口。
 */
export interface RemoteTransport {
  /** 获取 receive-pack ref 广告 */
  getReceivePackRefs(): Promise<RefAdvertisement>;
  /** 发送 receive-pack 请求 */
  postReceivePack(body: Buffer): Promise<{
    data: Buffer;
    refUpdates: PushRefUpdate[];
    progress: string[];
  }>;
  /** 获取 upload-pack ref 广告 */
  getRefAdvertisement(): Promise<RefAdvertisement>;
  /** 发送 upload-pack 请求 */
  postUploadPack(body: Buffer): Promise<{
    data: Buffer;
    packfile: Buffer;
    progress: string[];
  }>;
}

/**
 * 远程引用
 *
 * 表示服务端广告的单个 Git 引用。
 *
 * @example
 * ```ts
 * const ref: RemoteRef = {
 *   hash: sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"),
 *   name: "refs/heads/main",
 * };
 * ```
 */
export interface RemoteRef {
  /** 引用指向的对象哈希 */
  hash: SHA1;
  /** 引用完整名称，如 "refs/heads/main" */
  name: string;
  /** 如果引用是 annotated tag，此项为最终指向的 peeled 对象哈希 */
  peeled?: SHA1;
  /**
   * 符号引用目标
   * 如 "HEAD" → "refs/heads/main"
   */
  symrefTarget?: string;
}

/**
 * 服务端引用广告
 *
 * 包含服务端通过 ref advertisement 响应的能力声明和所有引用。
 *
 * @example
 * ```ts
 * const adv: RefAdvertisement = {
 *   capabilities: { multi_ack: true, "symref": "HEAD:refs/heads/main" },
 *   refs: [ { hash: sha1("..."), name: "refs/heads/main" } ],
 * };
 * ```
 */
export interface RefAdvertisement {
  /** 服务端能力声明 */
  capabilities: Record<string, string | true>;
  /** 所有广告的引用列表 */
  refs: RemoteRef[];
}

// ============================================================================
// Advertise 类型
// ============================================================================

/**
 * 广告获取选项
 */
export interface AdvertiseOptions {
  readonly token?: string;
  readonly headers?: Record<string, string>;
  readonly transport?: RemoteTransport;
}

/**
 * 标准化远端广告
 *
 * `defaultBranch` 在此统一提取，后续流程不再解析原始 `symref`。
 */
export interface RemoteAdvertisement {
  readonly capabilities: Record<string, string | true>;
  readonly refs: RemoteRef[];
  readonly defaultBranch?: string;
}

// ============================================================================
// Ref 规划类型
// ============================================================================

/**
 * Ref 映射规则
 */
export interface RefMappingRule {
  readonly source: string;
  readonly target: string;
  readonly force?: boolean;
}

/**
 * Ref 更新计划项
 */
export interface RefUpdatePlanItem {
  readonly remoteRef: RemoteRef;
  readonly localRef: string;
  readonly currentLocalHash?: SHA1;
  readonly force: boolean;
}

/**
 * Ref 更新计划
 */
export interface RefUpdatePlan {
  readonly wants: SHA1[];
  readonly matchedRemoteRefs: RemoteRef[];
  readonly updates: RefUpdatePlanItem[];
}

// ============================================================================
// FetchPack 类型
// ============================================================================

/**
 * Fetch-pack 操作选项
 *
 * 只接受 wants、depth、shallow 等协议级参数，不涉及 ref 映射。
 */
export interface FetchPackOptions {
  readonly url: string;
  readonly wants: SHA1[];
  /** 本地已有 commit tips，用于 negotiate 中作为 have 候选的遍历起点 */
  readonly haves?: SHA1[];
  readonly depth?: number;
  readonly shallow?: SHA1[];
  readonly token?: string;
  readonly headers?: Record<string, string>;
  readonly transport?: RemoteTransport;
  readonly maxCandidates?: number;
}

/**
 * Fetch-pack 操作结果
 */
export interface FetchPackResult {
  readonly objectCount: number;
  readonly shallow?: SHA1[];
  readonly unshallow?: SHA1[];
}

// ============================================================================
// Ref 更新类型
// ============================================================================

/**
 * Ref 更新拒绝项
 */
export interface RefUpdateRejection {
  readonly localRef: string;
  readonly reason: string;
}

/**
 * 应用 ref 更新结果
 */
export interface ApplyRefUpdatesResult {
  readonly updatedRefs: Map<string, SHA1>;
  readonly rejectedRefs: RefUpdateRejection[];
}

// ============================================================================
// Push 操作类型
// ============================================================================

/**
 * Push 操作选项
 *
 * 控制 push 行为。
 */
export interface PushOptions {
  /**
   * refspec 列表，格式如 "refs/heads/main:refs/heads/main"
   * 默认为将当前分支推送到远端同名分支（等价于 `git push <url>`）
   */
  refSpecs?: string[];

  /**
   * 认证 Token
   *
   * 设置后在所有请求中添加 `Authorization: Bearer <token>` 头。
   * 与 headers 同时设置时，token 优先转换为 Authorization 头，
   * 然后再合并 headers 中的其他字段。
   */
  token?: string;

  /**
   * 自定义 HTTP 请求头
   *
   * 注入到所有远程请求中。常用于：
   * - 自定义认证方式（如 `Authorization: token xxx`）
   * - CI 身份标识（如 `Job-Token: xxx`）
   * - 自定义 User-Agent
   */
  headers?: Record<string, string>;

  /** 是否强制推送（--force），等价于 refspec 的 + 前缀 */
  force?: boolean;

  /**
   * 已知的 shallow 边界 commit 哈希列表
   *
   * 设置此字段后，push 在遍历本地 commit 图遇到边界缺失 parent 时，
   * 会优先检查该哈希是否在 shallow 集合中：
   * - 如果在，按 shallow boundary 处理（允许正常的边界缺失）
   * - 如果不在，按本地损坏报错（避免误判）
   *
   * 通常由 Repository 层自动从 backend.shallow 读取，无需调用方手工设置。
   */
  shallowBoundaries?: SHA1[];

  /**
   * 可选的远程传输层实现
   *
   * 默认使用 Smart HTTP（调用 createSmartHttpClient）。
   * 传入此字段可注入替代实现用于测试。
   */
  transport?: RemoteTransport;
}

/**
 * 单条引用更新结果
 *
 * 表示服务端对单个引用更新命令的响应。
 */
export interface PushRefUpdate {
  /** 引用名称，如 "refs/heads/main" */
  refName: string;
  /** 更新前的哈希（服务端原有值） */
  oldHash: SHA1 | null;
  /** 更新后的哈希 */
  newHash: SHA1 | null;
  /** 是否成功 */
  success: boolean;
  /** 失败时的错误消息 */
  error?: string;
  /** 是否强制更新 */
  forced: boolean;
}

/**
 * Push 操作结果
 */
export interface PushResult {
  /** 已更新的引用列表 */
  refUpdates: PushRefUpdate[];
  /** 推送的对象数量 */
  objectCount: number;
  /** 服务端推送的进度消息 */
  progress: string[];
}
