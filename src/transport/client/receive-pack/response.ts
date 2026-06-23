/**
 * receive-pack 响应协议解码
 *
 * 从 transport 返回的原始 HTTP body 中解析 side-band 与 report-status。
 */

import { GitError } from "../../../core/errors.ts";
import { parsePktLines } from "../../protocol/pkt-line.ts";
import { parseReceivePackResult } from "./result.ts";

import type { PushRefUpdate } from "../../protocol/types.ts";

/**
 * receive-pack 响应解码错误
 */
export class ReceivePackResponseError extends GitError {
  constructor(message: string) {
    super(`receive-pack response: ${message}`);
    this.name = "ReceivePackResponseError";
  }
}

/**
 * 解码后的 receive-pack 响应
 */
export interface DecodedReceivePackResponse {
  readonly data: Buffer;
  readonly refUpdates: PushRefUpdate[];
  readonly progress: string[];
}

/**
 * 解码 receive-pack RPC 原始响应
 *
 * @param data - transport.request() 返回的原始 body
 */
export function decodeReceivePackResponse(data: Buffer): DecodedReceivePackResponse {
  let progress: string[] = [];
  let refUpdates: PushRefUpdate[] = [];

  const pktLines = parsePktLines(data);

  if (pktLines.length > 0 && pktLines[0]!.type === "data") {
    const firstPayload = pktLines[0]!.payload;
    if (
      firstPayload.length > 0 &&
      (firstPayload[0] === 0x01 || firstPayload[0] === 0x02 || firstPayload[0] === 0x03)
    ) {
      const reportStatusChunks: Buffer[] = [];

      for (const line of pktLines) {
        if (line.type !== "data") continue;
        const payload = line.payload;
        if (payload.length < 2) continue;

        const channel = payload[0]!;
        const frameData = payload.subarray(1);

        if (channel === 0x01) {
          reportStatusChunks.push(frameData);
        } else if (channel === 0x02) {
          progress.push(frameData.toString("utf-8").trimEnd());
        } else if (channel === 0x03) {
          throw new ReceivePackResponseError(
            `Server reported error: ${frameData.toString("utf-8").trimEnd()}`,
          );
        }
      }

      if (reportStatusChunks.length > 0) {
        const reconstructed = Buffer.concat(reportStatusChunks);
        refUpdates = parseReceivePackResult(reconstructed);
      }
    } else {
      refUpdates = parseReceivePackResult(data);
    }
  }

  return { data, refUpdates, progress };
}
