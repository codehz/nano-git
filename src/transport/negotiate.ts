/**
 * 请求生成（negotiate）
 *
 * 构造 Git upload-pack 请求 body。
 *
 * 协议 v1 的请求格式：
 *   want <hash> <capabilities>\n    （首行带 capabilities）
 *   want <hash>\n                    （后续 want）
 *   0000                             （flush）
 *   deepen <n>\n                     （可选，shallow fetch）
 *   0000                             （flush，如果有 deepen）
 *   have <hash>\n                    （当前实现一次性发送所有 haves）
 *   done\n
 *
 * @see https://git-scm.com/docs/git-upload-pack#_request
 */

import { encodePktLine, encodeFlushPkt, parsePktLines } from "./pkt-line.ts";
import type { PktLine } from "./pkt-line.ts";
import type { SHA1 } from "../core/types.ts";
import type { ObjectStore } from "../odb/types.ts";

/** 遍历提交图时的最大深度限制 */
const MAX_HAVE_DEPTH = 65536;

/** Consecutive 协商每轮发送的最大 have 数量 */
export const MAX_HAVES_PER_ROUND = 32;

// ============================================================================
// Have 收集（Consecutive 算法）
// ============================================================================

/**
 * 从起始哈希出发遍历 commit 图，收集所有可达 commit 哈希
 *
 * 沿 parent 链回溯，按提交时间戳从旧到新排序。
 * 这实现了 Consecutive 协商算法——发送完整的本地历史，
 * 让服务端能准确定位公共祖先，最小化增量传输。
 *
 * @param store - 对象存储
 * @param tips - 遍历起点（通常是本地远程跟踪 ref 的哈希）
 * @returns 按提交时间从旧到新排序的 commit 哈希列表
 *
 * @example
 * ```ts
 * const haves = collectHaveCommits(store, [localHash]);
 * // => [oldest_commit, ..., newest_commit]
 * ```
 */
export function collectHaveCommits(store: ObjectStore, tips: SHA1[]): SHA1[] {
  const seen = new Set<SHA1>();
  const commits: Array<{ hash: SHA1; timestamp: number }> = [];
  const queue: SHA1[] = [...tips];

  while (queue.length > 0) {
    const hash = queue.pop()!;
    if (seen.has(hash)) continue;
    if (seen.size >= MAX_HAVE_DEPTH) break;

    seen.add(hash);

    try {
      const obj = store.read(hash);
      if (obj.type !== "commit") continue;

      const commit = obj as import("../core/types.ts").GitCommit;
      commits.push({ hash, timestamp: commit.committer.timestamp });

      // 将父 commit 加入遍历队列
      for (const parentHash of commit.parents) {
        if (!seen.has(parentHash)) {
          queue.push(parentHash);
        }
      }
    } catch {
      // 对象不存在时跳过
      continue;
    }
  }

  // 按提交时间从旧到新排序（Consecutive 算法要求 oldest first）
  commits.sort((a, b) => a.timestamp - b.timestamp);
  return commits.map((c) => c.hash);
}

// ============================================================================
// 请求生成
// ============================================================================

/**
 * 构建 upload-pack 请求 body
 *
 * @param wants - 请求的 want 对象哈希列表（至少一个）
 * @param haves - 已有的 have 对象哈希列表（增量 fetch 时用）
 * @param capabilities - 能力列表（如 ["multi_ack", "side-band-64k", "ofs-delta"]）
 * @param depth - 可选 shallow clone 深度（设置后添加 deepen 命令）
 * @returns pkt-line 编码的请求 body Buffer
 *
 * @example
 * ```ts
 * // 初始 clone
 * const body = buildUploadPackRequest(
 *   [sha1("95d09f2b...")],
 *   [],
 *   ["multi_ack", "side-band-64k", "ofs-delta"],
 * );
 * // => "want 95d09f2b... multi_ack side-band-64k ofs-delta\n"
 * //   + "0000"
 * //   + "done\n"
 *
 * // Shallow clone
 * const shallow = buildUploadPackRequest(
 *   [sha1("95d09f2b...")],
 *   [],
 *   [],
 *   3,
 * );
 * // => "want 95d09f2b...\n"
 * //   + "0000"
 * //   + "deepen 3\n"
 * //   + "0000"
 * //   + "done\n"
 * ```
 */
export function buildUploadPackRequest(
  wants: SHA1[],
  haves: SHA1[],
  capabilities: string[],
  depth?: number,
): Buffer {
  if (wants.length === 0) {
    throw new Error("At least one want is required");
  }

  if (depth !== undefined && depth < 1) {
    throw new Error("Depth must be a positive integer");
  }

  const chunks: Buffer[] = [];

  // want 行：首行带 capabilities，后续不带
  for (let i = 0; i < wants.length; i++) {
    const hash = wants[i]!;
    if (i === 0 && capabilities.length > 0) {
      chunks.push(encodePktLine(`want ${hash} ${capabilities.join(" ")}\n`));
    } else {
      chunks.push(encodePktLine(`want ${hash}\n`));
    }
  }

  // deepen 命令（shallow fetch 时添加，必须在 flush 之前）
  if (depth !== undefined) {
    chunks.push(encodePktLine(`deepen ${depth}\n`));
  }

  // wants + deepen 之后的 flush
  chunks.push(encodeFlushPkt());

  // have 行：当前 fetch 编排使用单次 stateless-rpc 请求，
  // 一次性发送完整 have 列表，避免中间 flush 提前结束协商阶段。
  for (let i = 0; i < haves.length; i++) {
    chunks.push(encodePktLine(`have ${haves[i]!}\n`));
  }

  // done 命令
  chunks.push(encodePktLine("done\n"));

  return Buffer.concat(chunks);
}

/**
 * 构建不带 done 的 upload-pack 协商轮次请求
 *
 * @param wants - want 列表
 * @param haves - 本轮发送的 have 列表
 * @param capabilities - 能力列表
 * @param depth - shallow 深度
 * @returns pkt-line 编码请求体
 */
export function buildUploadPackNegotiationRound(
  wants: SHA1[],
  haves: SHA1[],
  capabilities: string[],
  depth?: number,
): Buffer {
  if (wants.length === 0) {
    throw new Error("At least one want is required");
  }

  if (depth !== undefined && depth < 1) {
    throw new Error("Depth must be a positive integer");
  }

  const chunks: Buffer[] = [];

  for (let i = 0; i < wants.length; i++) {
    const hash = wants[i]!;
    if (i === 0 && capabilities.length > 0) {
      chunks.push(encodePktLine(`want ${hash} ${capabilities.join(" ")}\n`));
    } else {
      chunks.push(encodePktLine(`want ${hash}\n`));
    }
  }

  // deepen 命令（shallow fetch 时添加，必须在 flush 之前）
  if (depth !== undefined) {
    chunks.push(encodePktLine(`deepen ${depth}\n`));
  }

  // wants + deepen 之后的 flush
  chunks.push(encodeFlushPkt());

  for (const hash of haves) {
    chunks.push(encodePktLine(`have ${hash}\n`));
  }

  chunks.push(encodeFlushPkt());

  return Buffer.concat(chunks);
}

/**
 * 协商 ACK 状态
 */
export type UploadPackAckStatus = "continue" | "common" | "ready";

/**
 * upload-pack 协商响应解析结果
 */
export interface UploadPackNegotiationResponse {
  acknowledgements: Array<{ hash: SHA1; status: UploadPackAckStatus }>;
  nak: boolean;
  hasPackfile: boolean;
}

/**
 * 解析 upload-pack 协商响应中的 ACK/NAK 与 packfile 信号
 */
export function parseUploadPackNegotiationResponse(data: Buffer): UploadPackNegotiationResponse {
  const acknowledgements: Array<{ hash: SHA1; status: UploadPackAckStatus }> = [];
  let nak = false;
  let hasPackfile = false;

  let pktLines: PktLine[];
  try {
    pktLines = parsePktLines(data);
  } catch {
    return { acknowledgements, nak, hasPackfile: data.includes("PACK") };
  }

  for (const line of pktLines) {
    if (line.type !== "data") {
      continue;
    }

    const payload = line.payload;

    if (payload.length > 0 && (payload[0] === 0x01 || payload[0] === 0x02 || payload[0] === 0x03)) {
      if (payload[0] === 0x01 && payload.subarray(1).includes("PACK")) {
        hasPackfile = true;
      }
      continue;
    }

    const text = payload.toString("utf-8").trimEnd();
    if (text === "NAK") {
      nak = true;
      continue;
    }

    const match = text.match(/^ACK ([0-9a-f]{40})(?: (continue|common|ready))?$/);
    if (match) {
      acknowledgements.push({
        hash: match[1]! as SHA1,
        status: (match[2] as UploadPackAckStatus | undefined) ?? "common",
      });
    }
  }

  if (!hasPackfile) {
    hasPackfile = data.includes("PACK");
  }

  return { acknowledgements, nak, hasPackfile };
}
