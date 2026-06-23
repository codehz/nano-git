/**
 * receive-pack 服务端类型定义与常量
 */

import { GitError } from "../../../core/errors.ts";
import { sha1 } from "../../../core/types.ts";

import type { SHA1 } from "../../../core/types.ts";

// ============================================================================
// 常量
// ============================================================================

/** 零哈希（表示新建或删除引用） */
export const ZERO_HASH = sha1("0000000000000000000000000000000000000000");

/** 服务端 agent 字符串 */
export const SERVER_AGENT = "nano-git/0.1";

/** side-band 通道编号：packfile 数据 / report-status */
export const CHANNEL_PACKFILE = 0x01;
/** side-band 通道编号：进度消息 */
export const CHANNEL_PROGRESS = 0x02;
/** side-band 通道编号：致命错误 */
export const _CHANNEL_FATAL = 0x03;

/** v1 广告中 prefix-ref 的 magic 名称 */
export const CAPABILITIES_REF = "capabilities^{}";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * receive-pack 服务错误
 *
 * 当请求解析、处理或响应生成过程中遇到可预见的错误时抛出。
 */
export class ReceivePackServiceError extends GitError {
  constructor(message: string) {
    super(`receive-pack: ${message}`);
    this.name = "ReceivePackServiceError";
  }
}

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Receive-pack 命令（ref 更新）
 *
 * 表示客户端请求的一次 ref 变更。
 */
export interface ReceivePackCommand {
  /** 客户端声称的服务端当前哈希（新建时为 000...0） */
  readonly oldHash: SHA1;
  /** 要设置的目标哈希（删除时为 000...0） */
  readonly newHash: SHA1;
  /** 引用完整名称，如 "refs/heads/main" */
  readonly refName: string;
}

/**
 * 解析后的 receive-pack 请求
 */
export interface ParsedReceivePackRequest {
  /** 客户端能力列表（首行 NUL 后的内容） */
  readonly capabilities: string[];
  /** ref 更新命令列表 */
  readonly commands: ReceivePackCommand[];
  /** packfile 数据（可能为空） */
  readonly packfile: Buffer;
}

/**
 * 单个 ref 更新的处理结果
 */
export interface ReceivePackUpdateResult {
  readonly refName: string;
  readonly success: boolean;
  readonly error?: string;
}

/**
 * receive-pack 处理选项
 */
export interface ReceivePackOptions {
  /**
   * 是否拒绝非 fast-forward 推送（类似 receive.denyNonFastForwards）
   * 默认 false
   */
  readonly denyNonFastForwards?: boolean;
}
