/**
 * Push 操作错误类型
 *
 * 当服务端部分或全部拒绝更新时抛出。
 * 即使抛出异常，`refUpdates` 属性仍会保留服务端返回的所有 ref 状态
 * （包含成功和失败的），以便调用方在部分成功场景下做出相应处理。
 */

import { GitError } from "../../../core/errors.ts";

import type { PushRefUpdate } from "../../protocol/types.ts";

/**
 * Push 操作错误
 *
 * 当服务端部分或全部拒绝更新时抛出。
 * 即使抛出异常，`refUpdates` 属性仍会保留服务端返回的所有 ref 状态
 * （包含成功和失败的），以便调用方在部分成功场景下做出相应处理。
 */
export class PushError extends GitError {
  /** 服务端返回的所有 ref 更新结果（包含成功和失败） */
  refUpdates?: PushRefUpdate[];
  /** 服务端返回的进度消息 */
  progress?: string[];

  constructor(message: string, extra?: { refUpdates?: PushRefUpdate[]; progress?: string[] }) {
    super(`Push error: ${message}`);
    this.name = "PushError";
    if (extra) {
      this.refUpdates = extra.refUpdates;
      this.progress = extra.progress;
    }
  }
}
