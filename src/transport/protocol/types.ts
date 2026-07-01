/**
 * Git 传输协议共享类型定义
 *
 * 定义了远程 Git 仓库交互所需的核心类型。
 * UploadPackTransport 与 ReceivePackTransport 同构：只负责广告与 RPC 原始响应，
 * 协议语义解析在 transport/protocol 层完成。
 */

import type { SHA1 } from "../../types/index.ts";

// ============================================================================
// 传输层接口（用于测试注入）
// ============================================================================

/**
 * Git 服务传输同构接口
 *
 * 只负责获取 ref 广告与发送 RPC body 并返回原始响应体。
 */
export interface GitServiceTransport {
  /** 获取 ref 广告（已解析为 RefAdvertisement，含 defaultBranch） */
  advertise(): Promise<RefAdvertisement>;
  /** 发送协议 RPC 请求，返回原始响应 body */
  request(body: Buffer): Promise<Buffer>;
}

/**
 * Upload-pack 传输接口（fetch）
 */
export type UploadPackTransport = GitServiceTransport;

/**
 * Receive-pack 传输接口（push）
 */
export type ReceivePackTransport = GitServiceTransport;

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
  /**
   * 远端默认分支（如 refs/heads/main）
   * 由 parseRefAdvertisement 统一解析，调用方不得再读 capabilities.symref
   */
  defaultBranch?: string;
}

// ============================================================================
// Ref 映射规则
// ============================================================================

/**
 * Ref 映射规则
 */
export interface RefMappingRule {
  readonly source: string;
  readonly target: string;
  readonly force?: boolean;
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
