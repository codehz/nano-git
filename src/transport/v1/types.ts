/**
 * v1 传输层类型定义
 *
 * Git Smart HTTP 协议 v1 专用类型。
 * 协议无关的共享类型见 shared/types.ts。
 */

import type { SHA1 } from "../../core/types.ts";
import type { RemoteRef } from "../shared/types.ts";

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

// ============================================================================
// 服务端引用广告类型
// ============================================================================

/**
 * 服务端引用广告
 */
export interface RefAdvertisement {
  /** 服务端能力声明 */
  capabilities: Record<string, string | true>;
  /** 所有广告的引用列表 */
  refs: RemoteRef[];
  /**
   * 远端默认分支（如 refs/heads/main）
   */
  defaultBranch?: string;
}

/**
 * 广告获取选项
 */
export interface AdvertiseOptions {
  readonly token?: string;
  readonly headers?: Record<string, string>;
}

// ============================================================================
// Ref 规划类型
// ============================================================================

/**
 * 匹配到的 ref 项（完整匹配结果）
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
 */
export interface RefUpdatePlanItem extends MatchedRefItem {}

/**
 * Fetch 规划结果
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
 */
export interface FetchPackOptions {
  readonly wants: SHA1[];
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
// Push 操作类型
// ============================================================================

/**
 * Push 操作选项
 */
export interface PushOptions {
  refSpecs?: string[];
  force?: boolean;
  shallowBoundaries?: SHA1[];
}

/**
 * 单条引用更新结果
 */
export interface PushRefUpdate {
  refName: string;
  oldHash: SHA1 | null;
  newHash: SHA1 | null;
  success: boolean;
  error?: string;
  forced: boolean;
}

/**
 * Push 操作结果
 */
export interface PushResult {
  refUpdates: PushRefUpdate[];
  objectCount: number;
  progress: string[];
}
