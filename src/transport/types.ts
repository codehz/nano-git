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

/**
 * Fetch 操作选项
 *
 * 控制 clone/fetch 行为。
 */
export interface FetchOptions {
  /**
   * refspec 列表，格式如 "+refs/heads/*:refs/remotes/origin/*"
   * 默认为 ["+refs/heads/*:refs/remotes/origin/*"]
   */
  refSpecs?: string[];
  /** shallow clone 深度（可选） */
  depth?: number;

  /**
   * 已有 shallow 边界 commit 哈希列表
   *
   * 进行增量 shallow fetch 时，传入之前保存的 shallow 边界哈希，
   * 服务端会据此决定哪些 commit 需要 unshallow 或保持 shallow。
   * 首次 shallow clone 时不需要设置此字段。
   */
  shallow?: SHA1[];

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

  /**
   * 可选的远程传输层实现
   *
   * 默认使用 Smart HTTP（调用 createSmartHttpClient）。
   * 传入此字段可注入替代实现用于测试。
   */
  transport?: RemoteTransport;

  /**
   * have 候选集上限
   *
   * 控制 collectHaveCommits 返回的最大 have 候选数量。
   * 设为 0 表示不限制（使用默认深度 65536）。
   * 默认值为 512。
   */
  maxCandidates?: number;
}

/**
 * Fetch 操作结果
 */
export interface FetchResult {
  /** 本地 ref → 新 hash 的映射 */
  fetchedRefs: Map<string, SHA1>;
  /** 获取的对象数量 */
  objectCount: number;
  /** shallow 边界 commit 哈希列表（仅 shallow fetch 时存在） */
  shallow?: SHA1[];
  /** 从 shallow 变为完整的 commit 哈希列表（仅增量 shallow fetch 时存在） */
  unshallow?: SHA1[];
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
   * 默认为 ["HEAD:refs/heads/main"]
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
