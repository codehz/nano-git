/**
 * Smart HTTP 传输层类型定义
 *
 * 定义了远程 Git 仓库交互所需的核心类型。
 * UploadPackTransport 与 ReceivePackTransport 各自独立，
 * fetch 和 push 不再共享同一个胖接口。
 */

import type { SHA1 } from "../core/types.ts";

// ============================================================================
// 传输层接口（用于测试注入）
// ============================================================================

/**
 * Upload-pack 传输接口
 *
 * 定义 fetch 操作所需的远程交互原语。
 * 只包含 upload-pack 协议的方法，不包含 receive-pack 相关。
 */
export interface UploadPackTransport {
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
 * Receive-pack 传输接口
 *
 * 定义 push 操作所需的远程交互原语。
 * 只包含 receive-pack 协议的方法，不包含 upload-pack 相关。
 */
export interface ReceivePackTransport {
  /** 获取 receive-pack ref 广告 */
  getReceivePackRefs(): Promise<RefAdvertisement>;
  /** 发送 receive-pack 请求 */
  postReceivePack(body: Buffer): Promise<{
    data: Buffer;
    refUpdates: PushRefUpdate[];
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
 * 匹配到的 ref 项（完整匹配结果）
 *
 * 每项保留完整的匹配信息，包含 hashEqual 标志。
 * 用于记录所有匹配到的远端 ref 与本地 ref 的对应关系。
 *
 * 注意：matchedItems ≠ refUpdates。只有 !hashEqual 的才会进入 refUpdates。
 * 即使 hashEqual 且对象缺失，wants 可非空而 refUpdates 为空。
 */
export interface MatchedRefItem {
  readonly remoteRef: RemoteRef;
  readonly localRef: string;
  readonly currentLocalHash?: SHA1;
  readonly force: boolean;
  /** 本地 hash 与远端 hash 是否相等 */
  readonly hashEqual: boolean;
}

/**
 * Ref 更新计划项
 *
 * 仅包含实际需要执行本地 ref 写入的项（即 hash 不相等的情况）。
 * 继承自匹配项的结构。
 */
export interface RefUpdatePlanItem extends MatchedRefItem {}

/**
 * Fetch 规划结果（由 planRefUpdates 直接产出）
 *
 * 同时包含 matchedRefs、matchedItems、refUpdates、wants。
 * - matchedItems：所有匹配结果（含 hashEqual 项）
 * - refUpdates：仅 !hashEqual 的实际需要写 ref 的项
 * - wants：需要传输的对象（!hashEqual 或 hashEqual 但对象缺失）
 *
 * 关键语义：
 * - matchedItems ≠ refUpdates
 * - wants 可以非空而 refUpdates 为空（例如 hashEqual + 对象缺失的补拉场景）
 *
 * 这样 no-op fetch（第二次 fetch 相同内容）可以有 matchedItems 但 refUpdates 为空。
 */
export interface FetchPlan {
  /** 所有匹配到的远端 refs */
  readonly matchedRefs: RemoteRef[];
  /** 所有匹配项（完整匹配结果，含 hashEqual） */
  readonly matchedItems: MatchedRefItem[];
  /** 实际需要写 ref 的结果（仅 !hashEqual） */
  readonly refUpdates: RefUpdatePlanItem[];
  /** 需要向服务器请求的 wants（含对象缺失补正） */
  readonly wants: SHA1[];
  /** 是否需要执行 fetch-pack 协商 */
  readonly needsPackNegotiation: boolean;
}

// ============================================================================
// FetchPack 类型
// ============================================================================

/**
 * Fetch-pack 操作选项
 *
 * 只接受 wants、depth、shallow 等协议级参数，不涉及 ref 映射。
 * url/token/headers/transport 不再出现在此处 ——
 * advertisement 和 UploadPackTransport 由调用方显式传入 fetchPack()。
 */
export interface FetchPackOptions {
  readonly wants: SHA1[];
  /** 本地已有 commit tips，用于 negotiate 中作为 have 候选的遍历起点 */
  readonly haves?: SHA1[];
  readonly depth?: number;
  readonly shallow?: SHA1[];
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
 * 控制 push 行为。纯 push 参数，不含传输层细节（transport、token、headers 等）。
 * 调用方需自行创建 ReceivePackTransport 并传入 push()。
 */
export interface PushOptions {
  /**
   * refspec 列表，格式如 "refs/heads/main:refs/heads/main"
   * 默认为将当前分支推送到远端同名分支（等价于 `git push <url>`）
   */
  refSpecs?: string[];

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
