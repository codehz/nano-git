/**
 * upload-pack 响应协议解码
 *
 * 从 transport 返回的原始 HTTP body 中解析 side-band、packfile 与进度消息。
 * HTTP 适配器不得包含此逻辑。
 */

import { GitError } from "../core/errors.ts";
import { PktLineError } from "./pkt-line.ts";
import {
  extractPackfile,
  extractProgress,
  extractRawPackfile,
  extractSideBandFatal,
  SideBandError,
} from "./side-band.ts";

/**
 * upload-pack 响应解码错误
 */
export class UploadPackResponseError extends GitError {
  constructor(message: string) {
    super(`upload-pack response: ${message}`);
    this.name = "UploadPackResponseError";
  }
}

/**
 * 解码后的 upload-pack 响应
 */
export interface DecodedUploadPackResponse {
  /** 原始响应体（用于 negotiation 解析） */
  readonly data: Buffer;
  /** 提取的 packfile（可能为空） */
  readonly packfile: Buffer;
  /** 进度消息 */
  readonly progress: string[];
}

function isRecoverablePktLineError(err: unknown): boolean {
  if (err instanceof PktLineError) {
    return true;
  }
  return err instanceof Error && err.message.includes("pkt-line error");
}

/**
 * 解码 upload-pack RPC 原始响应
 *
 * @param data - transport.request() 返回的原始 body
 */
export function decodeUploadPackResponse(data: Buffer): DecodedUploadPackResponse {
  const fatalMsg = extractSideBandFatal(data);
  if (fatalMsg !== null) {
    throw new UploadPackResponseError(`Server reported fatal error: ${fatalMsg}`);
  }

  let packfile: Buffer;
  let progress: string[];

  try {
    packfile = extractPackfile(data);
    try {
      progress = extractProgress(data);
    } catch (progressErr) {
      if (progressErr instanceof SideBandError) {
        progress = [];
      } else if (isRecoverablePktLineError(progressErr)) {
        progress = [];
      } else {
        throw progressErr;
      }
    }
  } catch (err) {
    if (err instanceof UploadPackResponseError) {
      throw err;
    }
    if (err instanceof SideBandError || isRecoverablePktLineError(err)) {
      try {
        const raw = extractRawPackfile(data);
        packfile =
          raw.length >= 4 && raw.toString("utf-8", 0, 4) === "PACK" ? raw : Buffer.alloc(0);
      } catch {
        packfile = Buffer.alloc(0);
      }
      progress = [];
    } else {
      throw new UploadPackResponseError(
        `Failed to parse upload-pack response: ${(err as Error).message}`,
      );
    }
  }

  return { data, packfile, progress };
}
