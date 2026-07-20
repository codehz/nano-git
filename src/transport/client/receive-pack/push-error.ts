/**
 * Push 操作错误类型
 *
 * 当服务端部分或全部拒绝更新时抛出。
 * 即使抛出异常，`refUpdates` 属性仍会保留服务端返回的所有 ref 状态
 * （包含成功和失败的），以便调用方在部分成功场景下做出相应处理。
 */

import { GitError } from "../../../errors.ts";

import type { GitErrorOptions } from "../../../errors.ts";
import type { PushRefUpdate } from "../../protocol/types.ts";

/**
 * PushError 构造选项
 */
export interface PushErrorOptions extends GitErrorOptions {
  /** 服务端返回的所有 ref 更新结果（包含成功和失败） */
  readonly refUpdates?: PushRefUpdate[];
  /** 服务端返回的进度消息 */
  readonly progress?: string[];
}

/**
 * Push 操作错误
 *
 * 当服务端部分或全部拒绝更新时抛出。
 * 即使抛出异常，`refUpdates` 属性仍会保留服务端返回的所有 ref 状态
 * （包含成功和失败的），以便调用方在部分成功场景下做出相应处理。
 *
 * @example
 * ```ts
 * throw new PushError("rejected", { refUpdates, cause: err });
 * ```
 */
export class PushError extends GitError {
  /** 服务端返回的所有 ref 更新结果（包含成功和失败） */
  readonly refUpdates?: PushRefUpdate[];
  /** 服务端返回的进度消息 */
  readonly progress?: string[];

  constructor(message: string, options?: PushErrorOptions) {
    super(`Push error: ${message}`, options);
    this.name = "PushError";
    this.refUpdates = options?.refUpdates;
    this.progress = options?.progress;
  }
}
