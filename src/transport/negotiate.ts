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
 *   shallow <hash>\n                 （可选，已有 shallow 边界）
 *   0000                             （flush）
 *   have <hash>\n                    （重放已确认 common + 本轮新 have）
 *   done\n                           （最终轮）
 *
 * 多轮 stateless-rpc 语义：
 * - 每轮 HTTP POST 都是独立的，服务端不维持状态
 * - 每轮必须重发完整前缀（want/deepen/shallow）
 * - 已确认 common 的 have 需要重放（但不需要重放全部历史 have）
 * - 最终轮以 done 结尾，中间轮以 flush 结尾
 *
 * @see https://git-scm.com/docs/git-upload-pack#_request
 * @see https://git-scm.com/docs/http-protocol
 */

import { encodePktLine, encodeFlushPkt, parsePktLines } from "./pkt-line.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectStore } from "../odb/types.ts";
import type { PktLine } from "./pkt-line.ts";

/** 遍历提交图时的最大深度限制 */
const MAX_HAVE_DEPTH = 65536;

/** Consecutive 协商每轮发送的最大 have 数量 */
export const MAX_HAVES_PER_ROUND = 32;

// ============================================================================
// Have 候选选择与收集
// ============================================================================

/** have 候选收集策略 */
export type HaveCollectionStrategy = "full" | "bounded" | "sparse";

/** have 候选收集选项 */
export interface HaveSelectionOptions {
  /** 候选集上限，默认不限制 */
  maxCandidates?: number;
}

/**
 * 从起始哈希出发遍历 commit 图，收集可达 commit 哈希
 *
 * 沿 parent 链回溯，按提交时间戳从旧到新排序。
 * 这实现了 Consecutive 协商算法——发送本地历史，
 * 让服务端能准确定位公共祖先，最小化增量传输。
 *
 * @param store - 对象存储
 * @param tips - 遍历起点
 * @param options - 可选配置（maxCandidates 控制候选集上限）
 * @returns 按提交时间从旧到新排序的 commit 哈希列表
 *
 * @example
 * ```ts
 * const haves = collectHaveCommits(store, [localHash]);
 * // => [oldest_commit, ..., newest_commit]
 *
 * const havesLimited = collectHaveCommits(store, [localHash], { maxCandidates: 256 });
 * // => 最多 256 个
 * ```
 */
export function collectHaveCommits(
  store: ObjectStore,
  tips: SHA1[],
  options?: HaveSelectionOptions,
): SHA1[] {
  const seen = new Set<SHA1>();
  const commits: Array<{ hash: SHA1; timestamp: number }> = [];
  const queue: SHA1[] = [...tips];

  const maxCandidates = options?.maxCandidates ?? MAX_HAVE_DEPTH;
  const effectiveMax = Math.min(maxCandidates, MAX_HAVE_DEPTH);

  while (queue.length > 0) {
    const hash = queue.pop()!;
    if (seen.has(hash)) continue;
    if (seen.size >= effectiveMax) break;

    seen.add(hash);

    try {
      const obj = store.read(hash);
      if (obj.type !== "commit") continue;

      const commit = obj as import("../core/types.ts").GitCommit;
      commits.push({ hash, timestamp: commit.committer.timestamp });

      // 将父 commit 加入遍历队列
      for (const parentHash of commit.parents) {
        if (!seen.has(parentHash) && seen.size < effectiveMax) {
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
// 请求前缀构造
// ============================================================================

/**
 * upload-pack 请求前缀选项
 */
export interface UploadPackRequestPrefixOptions {
  /** 请求的 want 对象哈希列表（至少一个） */
  wants: SHA1[];
  /** 能力列表（如 ["multi_ack", "side-band-64k", "ofs-delta"]） */
  capabilities: string[];
  /** 可选 shallow clone 深度 */
  depth?: number;
  /** 可选已有 shallow 边界 commit 列表 */
  shallow?: SHA1[];
}

/**
 * 构建 upload-pack 请求前缀
 *
 * 生成包含 want、deepen、shallow 行的固定前缀部分，以 flush 结尾。
 * 此前缀在多轮 stateless-rpc 协商中每轮都必须重发。
 * 不包含任何 have 行。
 *
 * @param options - 前缀选项
 * @returns pkt-line 编码的前缀 Buffer
 *
 * @example
 * ```ts
 * const prefix = buildUploadPackRequestPrefix({
 *   wants: [sha1("95d09f2b...")],
 *   capabilities: ["multi_ack", "side-band-64k"],
 * });
 * // => "want 95d09f2b... multi_ack side-band-64k\n"
 * //   + "0000"
 * ```
 */
export function buildUploadPackRequestPrefix(options: UploadPackRequestPrefixOptions): Buffer {
  const { wants, capabilities, depth, shallow } = options;

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

  // deepen 命令（shallow fetch 时添加）
  if (depth !== undefined) {
    chunks.push(encodePktLine(`deepen ${depth}\n`));
  }

  // shallow 行（已有 shallow 边界，在 deepen 之后、flush 之前）
  if (shallow !== undefined && shallow.length > 0) {
    for (const hash of shallow) {
      chunks.push(encodePktLine(`shallow ${hash}\n`));
    }
  }

  // wants + deepen + shallow 之后的 flush
  chunks.push(encodeFlushPkt());

  return Buffer.concat(chunks);
}

/**
 * 构建 upload-pack 协商轮次请求（完整 body）
 *
 * 在已构建的前缀后追加 have 行和结束标记。
 * 适用于多轮 stateless-rpc 协商场景。
 *
 * @param prefix - 由 buildUploadPackRequestPrefix 生成的前缀
 * @param replayHaves - 需要重放的已确认 common 的 have 列表
 * @param newHaves - 本轮新增的 have 列表
 * @param done - 是否为最终轮（true 时以 done\n 结尾，false 时以 flush 结尾）
 * @returns pkt-line 编码的完整请求 body Buffer
 *
 * @example
 * ```ts
 * // 中间轮次
 * const body = buildUploadPackNegotiationRequest(prefix, [commonHash], [newHash], false);
 * // => prefix + "have <common>\n" + "have <new>\n" + "0000"
 *
 * // 最终轮次
 * const finalBody = buildUploadPackNegotiationRequest(prefix, [commonHash], [], true);
 * // => prefix + "have <common>\n" + "done\n"
 * ```
 */
export function buildUploadPackNegotiationRequest(
  prefix: Buffer,
  replayHaves: SHA1[],
  newHaves: SHA1[],
  done: boolean,
): Buffer {
  const chunks: Buffer[] = [prefix];

  for (const hash of replayHaves) {
    chunks.push(encodePktLine(`have ${hash}\n`));
  }

  for (const hash of newHaves) {
    chunks.push(encodePktLine(`have ${hash}\n`));
  }

  if (done) {
    chunks.push(encodePktLine("done\n"));
  } else {
    chunks.push(encodeFlushPkt());
  }

  return Buffer.concat(chunks);
}

// ============================================================================
// 请求构造（单轮便捷包装）
// ============================================================================

/**
 * 构建单轮 upload-pack 请求 body
 *
 * 便捷包装函数，内部调用 buildUploadPackRequestPrefix 和
 * buildUploadPackNegotiationRequest。适用于一次性请求场景
 *（如初始 clone 或 haves 数量不超过 MAX_HAVES_PER_ROUND 的增量 fetch）。
 *
 * @param wants - 请求的 want 对象哈希列表（至少一个）
 * @param haves - 已有的 have 对象哈希列表
 * @param capabilities - 能力列表
 * @param depth - 可选 shallow clone 深度
 * @param shallow - 可选已有 shallow 边界 commit 列表
 * @returns pkt-line 编码的请求 body Buffer（始终以 done 结尾）
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
 * // 增量 shallow fetch：带上已有 shallow 边界
 * const followUp = buildUploadPackRequest(
 *   [sha1("new-commit...")],
 *   [sha1("old-commit...")],
 *   ["shallow"],
 *   3,
 *   [sha1("existing-shallow-boundary...")],
 * );
 * ```
 */
export function buildUploadPackRequest(
  wants: SHA1[],
  haves: SHA1[],
  capabilities: string[],
  depth?: number,
  shallow?: SHA1[],
): Buffer {
  const prefix = buildUploadPackRequestPrefix({ wants, capabilities, depth, shallow });
  return buildUploadPackNegotiationRequest(prefix, [], haves, true);
}

/**
 * @deprecated 请使用 buildUploadPackRequestPrefix + buildUploadPackNegotiationRequest
 *             替代。此函数在内部构造前缀并追加 haves，但不支持 replayHaves。
 */
export function buildUploadPackNegotiationRound(
  wants: SHA1[],
  haves: SHA1[],
  capabilities: string[],
  depth?: number,
  shallow?: SHA1[],
): Buffer {
  const prefix = buildUploadPackRequestPrefix({ wants, capabilities, depth, shallow });
  return buildUploadPackNegotiationRequest(prefix, [], haves, false);
}

// ============================================================================
// 协商状态
// ============================================================================

/**
 * 多轮 stateless-rpc 协商状态
 *
 * 跨 HTTP POST 维护协商上下文，确保每轮请求都能正确
 * 重放服务端已确认的公共点（common）。
 */
export interface NegotiationState {
  /** 下一轮必须重放的、已被服务端确认的公共点 */
  commonToReplay: SHA1[];
  /** common 去重集合 */
  commonSet: Set<SHA1>;
  /** 已发送过 have 的 commit 集合，避免重复 */
  sentSet: Set<SHA1>;
  /** have 候选列表的遍历偏移 */
  offset: number;
  /** 跨轮累计的 shallow 边界 */
  shallow: SHA1[];
  /** 跨轮累计的 unshallow 边界 */
  unshallow: SHA1[];
}

/**
 * 创建初始协商状态
 */
export function createNegotiationState(): NegotiationState {
  return {
    commonToReplay: [],
    commonSet: new Set(),
    sentSet: new Set(),
    offset: 0,
    shallow: [],
    unshallow: [],
  };
}

/**
 * 吸收 ACK 回复中的 common/ready 信息到协商状态
 *
 * 将服务端确认的公共点加入 commonToReplay，
 * 确保下一轮请求会重放这些 have。
 *
 * @param state - 协商状态
 * @param ack - ACK 回复条目
 */
export function absorbAckCommon(
  state: NegotiationState,
  ack: { hash: SHA1; status: UploadPackAckStatus },
): void {
  if (ack.status === "common" || ack.status === "ready") {
    if (!state.commonSet.has(ack.hash)) {
      state.commonSet.add(ack.hash);
      state.commonToReplay.push(ack.hash);
    }
  }
}

/**
 * 合并 shallow/unshallow 信息到协商状态
 *
 * @param state - 协商状态
 * @param response - 本轮协商响应
 */
export function mergeShallowInfo(
  state: NegotiationState,
  response: UploadPackNegotiationResponse,
): void {
  for (const h of response.shallow) {
    if (!state.shallow.includes(h)) {
      state.shallow.push(h);
    }
  }
  for (const h of response.unshallow) {
    if (!state.unshallow.includes(h)) {
      state.unshallow.push(h);
    }
  }
}

/**
 * 获取下一批待发送的 have 候选
 *
 * 从 haves 列表中按顺序取出最多 maxPerRound 个未发送过的 commit。
 *
 * @param haves - 完整 have 候选列表（Consecutive 排序）
 * @param state - 协商状态
 * @param maxPerRound - 每轮最大发送数量
 * @returns 本轮新增的 have 列表
 */
export function nextHaveChunk(haves: SHA1[], state: NegotiationState, maxPerRound: number): SHA1[] {
  const chunk: SHA1[] = [];
  while (state.offset < haves.length && chunk.length < maxPerRound) {
    const hash = haves[state.offset]!;
    state.offset++;
    if (!state.sentSet.has(hash)) {
      state.sentSet.add(hash);
      chunk.push(hash);
    }
  }
  return chunk;
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
  /** shallow 边界 commit 哈希列表（deepen 请求后服务器返回） */
  shallow: SHA1[];
  /** 从 shallow 变为完整的 commit 哈希列表（增量 fetch 时服务器返回） */
  unshallow: SHA1[];
}

/**
 * 解析 upload-pack 协商响应中的 ACK/NAK 与 packfile 信号
 */
export function parseUploadPackNegotiationResponse(data: Buffer): UploadPackNegotiationResponse {
  const acknowledgements: Array<{ hash: SHA1; status: UploadPackAckStatus }> = [];
  let nak = false;
  let hasPackfile = false;
  const shallow: SHA1[] = [];
  const unshallow: SHA1[] = [];

  let pktLines: PktLine[];
  try {
    pktLines = parsePktLines(data);
  } catch {
    return { acknowledgements, nak, hasPackfile, shallow, unshallow };
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

    const shallowMatch = text.match(/^shallow ([0-9a-f]{40})$/);
    if (shallowMatch) {
      shallow.push(shallowMatch[1] as SHA1);
      continue;
    }

    const unshallowMatch = text.match(/^unshallow ([0-9a-f]{40})$/);
    if (unshallowMatch) {
      unshallow.push(unshallowMatch[1] as SHA1);
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

  return { acknowledgements, nak, hasPackfile, shallow, unshallow };
}
