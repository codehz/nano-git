/**
 * receive-pack report-status 响应生成
 *
 * 生成 unpack 状态和 ref 更新结果的 pkt-line 编码响应。
 * 支持 side-band-64k 编码（progress 在 channel 2，report-status 在 channel 1）。
 */

import { encodePktLine, encodeFlushPkt } from "../../shared/pkt-line.ts";
import { CHANNEL_PACKFILE, CHANNEL_PROGRESS } from "./types.ts";

import type { V1RefUpdateResult } from "./types.ts";

/**
 * 编码 side-band 帧
 */
function encodeSideBandFrame(channel: number, data: Buffer): Buffer {
  const frame = Buffer.alloc(1 + data.length);
  frame[0] = channel;
  data.copy(frame, 1);
  return encodePktLine(frame);
}

/**
 * 生成 receive-pack 的 report-status 响应
 *
 * 格式（无 side-band）：
 * ```
 * unpack <ok|error>\n
 * ok <refname>\n
 * ng <refname> <error>\n
 * ...
 * 0000
 * ```
 *
 * 格式（带 side-band-64k）：
 * ```
 * <side-band channel 2: progress>
 * <side-band channel 1: report-status lines>
 * 0000
 * ```
 *
 * @param unpackOk - 解包是否成功
 * @param unpackError - 解包错误消息（unpackOk 为 false 时）
 * @param refResults - 各 ref 的更新结果
 * @param useSideBand - 是否使用 side-band-64k 编码
 * @returns 完整的响应 Buffer
 */
export function generateV1ReportStatus(
  unpackOk: boolean,
  unpackError: string | undefined,
  refResults: V1RefUpdateResult[],
  useSideBand: boolean,
): Buffer {
  const statusLines: Buffer[] = [];

  // unpack 状态行
  if (unpackOk) {
    statusLines.push(Buffer.from("unpack ok\n", "utf-8"));
  } else {
    statusLines.push(Buffer.from(`unpack ${unpackError ?? "unknown error"}\n`, "utf-8"));
  }

  // ref 更新状态行
  for (const result of refResults) {
    if (result.success) {
      statusLines.push(Buffer.from(`ok ${result.refName}\n`, "utf-8"));
    } else {
      statusLines.push(
        Buffer.from(`ng ${result.refName} ${result.error ?? "unknown error"}\n`, "utf-8"),
      );
    }
  }

  const reportStatusData = Buffer.concat(statusLines);

  // 构建 pkt-line 编码的 report-status 序列（无 side-band 时直接发送，有 side-band 时放在 channel 1 中）
  const pktParts: Buffer[] = [];

  // 将 report-status 拆分为 pkt-line 帧
  const lines = reportStatusData.toString("utf-8").split("\n");
  for (const line of lines) {
    if (line.length > 0) {
      pktParts.push(encodePktLine(line + "\n"));
    }
  }

  pktParts.push(encodeFlushPkt());
  const reportPktSequence = Buffer.concat(pktParts);

  if (!useSideBand) {
    return reportPktSequence;
  }

  // 带 side-band-64k：progress 在 channel 2，report-status（pkt-line 编码）在 channel 1
  const parts: Buffer[] = [];

  // progress 消息
  const progressMsg = `Unpacking objects: 100% (${refResults.length}/${refResults.length})\n`;
  parts.push(encodeSideBandFrame(CHANNEL_PROGRESS, Buffer.from(progressMsg, "utf-8")));

  // report-status 在 channel 1（内层已是 pkt-line 编码）
  parts.push(encodeSideBandFrame(CHANNEL_PACKFILE, reportPktSequence));

  // 外层 flush（终止 side-band demultiplexer）
  parts.push(encodeFlushPkt());

  return Buffer.concat(parts);
}
