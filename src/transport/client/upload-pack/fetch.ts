/**
 * v2 fetch 命令
 *
 * 在 Git Wire 协议 v2 中，fetch 替代了 v1 的 upload-pack 协商 + packfile 传输。
 * 支持 want/have/done、want-ref、shallow、thin-pack 等参数。
 *
 * 请求格式：
 * ```
 * command=fetch\n
 * agent=nano-git/0.1\n
 * ofs-delta\n
 * include-tag\n
 * 0001
 * want <oid>\n
 * have <oid>\n
 * done\n
 * 0000
 * ```
 *
 * 响应格式（节之间由 0001 分隔）：
 * ```
 * acknowledgments\n
 * NAK\n (或 ACK <oid>\n ... ready\n)
 * 0001
 * shallow-info\n
 * shallow <oid>\n
 * 0001
 * wanted-refs\n
 * <oid> <refname>\n
 * 0001
 * packfile\n
 * [side-band 多路复用数据]
 * 0000
 * ```
 *
 * @see https://git-scm.com/docs/protocol-v2#_fetch
 */

import { GitError } from "../../../errors.ts";
import { createPackReader, packObjectToRaw } from "../../../pack/reader/pack-reader.ts";
import { splitPktLinesFromBuffer } from "../../protocol/pkt-line.ts";

import type { ObjectDatabase } from "../../../odb/types.ts";
import type { V2GitServiceTransport, V2FetchResponse } from "./types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * v2 fetch 命令错误
 */
export class V2FetchError extends GitError {
  constructor(message: string) {
    super(`v2 fetch error: ${message}`);
    this.name = "V2FetchError";
  }
}

// ============================================================================
// 常量
// ============================================================================

/** 单轮最多发送的 have 数量 */
const MAX_HAVES_PER_ROUND = 32;

/** 侧信道通道编号 */
const CHANNEL_PACKFILE = 0x01;

// ============================================================================
// fetch 命令执行
// ============================================================================

/**
 * v2 fetch 参数
 *
 * 对应 git protocol v2 fetch 命令的 arguments 段参数。
 */
export interface V2FetchParams {
  /** want 列表（对象哈希） */
  readonly wants: string[];
  /** have 列表（对象哈希） */
  readonly haves?: string[];
  /** 是否发送 done（结束协商，直接要求 packfile） */
  readonly done?: boolean;
  /** want-ref 列表（按 ref 名请求） */
  readonly wantRefs?: string[];
  /** 是否请求 thin-pack */
  readonly thinPack?: boolean;
  /** 是否禁用进度消息 */
  readonly noProgress?: boolean;
  /** 是否请求 include-tag */
  readonly includeTag?: boolean;
  /** 是否支持 ofs-delta */
  readonly ofsDelta?: boolean;
  /** shallow 边界 */
  readonly shallow?: string[];
  /** deepen 深度 */
  readonly deepen?: number;
  /** deepen-relative 标志 */
  readonly deepenRelative?: boolean;
  /** deepen-since 时间戳 */
  readonly deepenSince?: number;
  /** deepen-not 排除 */
  readonly deepenNot?: string[];
  /** filter 表达式 */
  readonly filter?: string;
  /** sideband-all 标志 */
  readonly sidebandAll?: boolean;
  /** wait-for-done 标志 */
  readonly waitForDone?: boolean;
}

/**
 * 执行 v2 fetch 命令
 *
 * 构建并发送 fetch 请求，返回解析后的完整响应。
 *
 * @param transport - v2 传输接口
 * @param params - fetch 参数
 * @param features - 服务端 fetch 命令支持的附加特性
 * @returns 解析后的 fetch 响应
 * @throws {V2FetchError} 当 wants 为空时
 *
 * @example
 * ```ts
 * const result = await v2Fetch(transport, {
 *   wants: [hash1, hash2],
 *   ofsDelta: true,
 *   done: true,
 * });
 * console.log(result.packfile?.length); // packfile 数据长度
 * ```
 */
export async function v2Fetch(
  transport: V2GitServiceTransport,
  params: V2FetchParams,
  features?: string[],
): Promise<V2FetchResponse> {
  if (params.wants.length === 0) {
    throw new V2FetchError("No wants specified for fetch");
  }

  // 检查特性支持：features === undefined 表示不支持任何附加特性
  const hasFeature = (name: string): boolean => features !== undefined && features.includes(name);

  // 构建 arguments（所有 fetch 参数都在分隔符之后）
  const args: string[] = [];

  // 传输参数（thin-pack、ofs-delta 等是 v2 fetch 的 argument，不是 capability）
  if (params.thinPack) args.push("thin-pack");
  if (params.noProgress) args.push("no-progress");
  if (params.includeTag) args.push("include-tag");
  if (params.ofsDelta) args.push("ofs-delta");
  if (params.sidebandAll) args.push("sideband-all");
  if (params.waitForDone) args.push("wait-for-done");

  // want 列表
  for (const oid of params.wants) {
    args.push(`want ${oid}`);
  }

  // want-ref（需要 ref-in-want 特性支持）
  if (params.wantRefs && hasFeature("ref-in-want")) {
    for (const ref of params.wantRefs) {
      args.push(`want-ref ${ref}`);
    }
  }

  // done 标记
  if (params.done) {
    args.push("done");
  }

  // 不需要 done 时才发送 have
  if (!params.done && params.haves) {
    for (const oid of params.haves) {
      args.push(`have ${oid}`);
    }
  }

  // shallow 参数
  if (params.shallow && hasFeature("shallow")) {
    for (const oid of params.shallow) {
      args.push(`shallow ${oid}`);
    }
  }

  if (params.deepen !== undefined && hasFeature("shallow")) {
    args.push(`deepen ${params.deepen}`);
  }

  if (params.deepenRelative && hasFeature("shallow")) {
    args.push("deepen-relative");
  }

  if (params.deepenSince !== undefined && hasFeature("shallow")) {
    args.push(`deepen-since ${params.deepenSince}`);
  }

  if (params.deepenNot && hasFeature("shallow")) {
    for (const rev of params.deepenNot) {
      args.push(`deepen-not ${rev}`);
    }
  }

  if (params.filter && hasFeature("filter")) {
    args.push(`filter ${params.filter}`);
  }

  // capabilities-list（仅放通用能力，如 agent）
  // 当前不使用通用能力，留空即可

  const response = await transport.command("fetch", args, []);

  return parseV2FetchResponse(response, params.done ?? false, hasFeature("sideband-all"));
}

// ============================================================================
// 响应解析
// ============================================================================

/**
 * 解析 v2 fetch 响应
 *
 * v2 fetch 响应由多个节组成，节之间由 delimiter (0001) 分隔。
 * 每个节以节头（如 "acknowledgments"）开始。
 *
 * @param data - 原始响应数据
 * @param hasDone - 请求中是否包含 done
 * @param sidebandAll - 是否协商了 sideband-all
 * @returns 解析后的 fetch 响应
 *
 * @example
 * ```ts
 * const result = parseV2FetchResponse(responseData, true, false);
 * if (result.packfile) {
 *   // 处理 packfile
 * }
 * ```
 */
export function parseV2FetchResponse(
  data: Buffer,
  _hasDone: boolean,
  sidebandAll: boolean,
): V2FetchResponse {
  // 使用 splitPktLinesFromBuffer 优雅处理尾部非 pkt-line 数据
  const { lines: pktLines, trailing } = splitPktLinesFromBuffer(data);

  // 跳过 sideband-all 的 channel 字节（如果启用了 sideband-all）
  if (sidebandAll && pktLines.length > 0) {
    const first = pktLines[0];
    if (first?.type === "data" && first.payload.length > 1) {
      const withoutChannel = Buffer.concat(
        pktLines
          .filter((p): p is typeof first => p.type === "data")
          .map((p) => p.payload.subarray(1)),
      );
      return parseV2FetchResponse(Buffer.concat([withoutChannel, trailing]), false, false);
    }
  }

  // 解析节结构
  interface MutableSection {
    header: string;
    lines: Buffer[];
  }
  const sections: MutableSection[] = [];
  let currentSection: MutableSection | null = null;
  const packfileFrames: Buffer[] = [];
  let inPackfile = false;

  for (const pkt of pktLines) {
    if (pkt.type === "flush") {
      break;
    }

    if (pkt.type === "delimiter") {
      currentSection = null;
      inPackfile = false;
      continue;
    }

    if (pkt.type !== "data") continue;

    const payload = pkt.payload;
    const text = payload.toString("utf-8");
    const trimmed = text.replace(/\n$/, "");

    if (currentSection === null && !inPackfile) {
      currentSection = { header: trimmed, lines: [] };
      sections.push(currentSection);
      if (trimmed === "packfile") {
        inPackfile = true;
        // 将当前 payload 中节头后的剩余数据加入 packfile 帧
        const headerEndIndex = text.indexOf("\n") + 1;
        if (headerEndIndex > 0 && headerEndIndex < payload.length) {
          packfileFrames.push(payload.subarray(headerEndIndex));
        }
      }
    } else if (inPackfile) {
      packfileFrames.push(payload);
    } else if (currentSection) {
      currentSection.lines.push(payload);
    }
  }

  // packfile 尾部数据也加入（splitPktLinesFromBuffer 道出的 trailing 数据）
  if (trailing.length > 0) {
    packfileFrames.push(trailing);
  }

  // 组装结果
  const result: {
    acknowledgments?: { nak?: boolean; acks: string[]; ready?: boolean };
    shallowInfo?: { shallow: string[]; unshallow: string[] };
    wantedRefs?: Array<{ oid: string; refname: string }>;
    packfileUris?: Array<{ oid: string; uri: string }>;
    packfile?: Buffer;
  } = {};

  for (const section of sections) {
    switch (section.header) {
      case "acknowledgments":
        result.acknowledgments = parseAcknowledgments(section.lines);
        break;
      case "shallow-info":
        result.shallowInfo = parseShallowInfo(section.lines);
        break;
      case "wanted-refs":
        result.wantedRefs = parseWantedRefs(section.lines);
        break;
      case "packfile-uris":
        result.packfileUris = parsePackfileUris(section.lines);
        break;
      case "packfile":
        if (packfileFrames.length > 0) {
          result.packfile = extractPackfileFromFrames(packfileFrames);
        }
        break;
    }
  }

  return result as V2FetchResponse;
}

// ============================================================================
// 内部解析函数
// ============================================================================

/**
 * 解析 acknowledgments 节
 *
 * ```
 * acknowledgments\n
 * NAK\n
 * --- 或 ---
 * ACK <oid>\n
 * ACK <oid>\n
 * ready\n
 * ```
 */
function parseAcknowledgments(lines: Buffer[]): { nak?: boolean; acks: string[]; ready?: boolean } {
  const acks: string[] = [];
  let nak = false;
  let ready = false;

  for (const line of lines) {
    const text = line.toString("utf-8").trim();
    if (text === "NAK") {
      nak = true;
    } else if (text === "ready") {
      ready = true;
    } else if (text.startsWith("ACK ")) {
      acks.push(text.substring(4).trim());
    }
  }

  return { nak, acks, ready };
}

/**
 * 解析 shallow-info 节
 *
 * ```
 * shallow-info\n
 * shallow <oid>\n
 * unshallow <oid>\n
 * ```
 */
function parseShallowInfo(lines: Buffer[]): { shallow: string[]; unshallow: string[] } {
  const shallow: string[] = [];
  const unshallow: string[] = [];

  for (const line of lines) {
    const text = line.toString("utf-8").trim();
    if (text.startsWith("shallow ")) {
      shallow.push(text.substring(8).trim());
    } else if (text.startsWith("unshallow ")) {
      unshallow.push(text.substring(10).trim());
    }
  }

  return { shallow, unshallow };
}

/**
 * 解析 wanted-refs 节
 *
 * ```
 * wanted-refs\n
 * <oid> <refname>\n
 * ```
 */
function parseWantedRefs(lines: Buffer[]): Array<{ oid: string; refname: string }> {
  const refs: Array<{ oid: string; refname: string }> = [];

  for (const line of lines) {
    const text = line.toString("utf-8").trim();
    if (text.length === 0) continue;

    const spaceIdx = text.indexOf(" ");
    if (spaceIdx === -1) continue;

    refs.push({
      oid: text.substring(0, spaceIdx),
      refname: text.substring(spaceIdx + 1).trim(),
    });
  }

  return refs;
}

/**
 * 解析 packfile-uris 节
 *
 * ```
 * packfile-uris\n
 * <oid> <uri>\n
 * ```
 */
function parsePackfileUris(lines: Buffer[]): Array<{ oid: string; uri: string }> {
  const uris: Array<{ oid: string; uri: string }> = [];

  for (const line of lines) {
    const text = line.toString("utf-8").trim();
    if (text.length === 0) continue;

    const spaceIdx = text.indexOf(" ");
    if (spaceIdx === -1) continue;

    uris.push({
      oid: text.substring(0, spaceIdx),
      uri: text.substring(spaceIdx + 1).trim(),
    });
  }

  return uris;
}

/**
 * 从 side-band pkt-line payload 帧中提取 packfile 数据
 *
 * v2 fetch 响应中 packfile 节的每个 pkt-line payload 格式为：
 * <1-byte-channel><data>
 * channel 1 = packfile 数据
 * channel 2 = 进度消息
 * channel 3 = 致命错误
 *
 * @param frames - pkt-line payload 数组（不含长度前缀，含 channel 字节）
 * @returns 拼接后的完整 packfile buffer
 */
function extractPackfileFromFrames(frames: Buffer[]): Buffer {
  const chunks: Buffer[] = [];

  for (const frame of frames) {
    if (frame.length < 1) continue;

    const channel = frame[0]!;

    if (channel === CHANNEL_PACKFILE) {
      chunks.push(frame.subarray(1));
    }
    // channel 2 为进度消息，忽略
    // channel 3 为致命错误，由外部函数处理
  }

  if (chunks.length === 0) {
    throw new V2FetchError("No packfile data found in fetch response");
  }

  return Buffer.concat(chunks);
}

// ============================================================================
// 多轮协商
// ============================================================================

/**
 * v2 多轮协商状态
 */
interface NegotiationState {
  /** 已发送的 have 集合 */
  readonly sent: Set<string>;
  /** 所有可用的 have（按时间从旧到新排序） */
  readonly candidates: string[];
  /** 当前已发送的候选下标 */
  offset: number;
  /** 最后一次 ACK 的 common 对象 */
  common: string[];
}

/**
 * 执行 v2 多轮 fetch 协商
 *
 * v2 的 fetch 协商与 v1 类似，但使用不同的请求/响应格式。
 * 多轮协商中，中间轮以 flush 结尾（不含 done），
 * 最终轮以 done 结尾。
 *
 * @param transport - v2 传输接口
 * @param wants - want 列表
 * @param haveCandidates - have 候选列表（按时间从旧到新排序）
 * @param features - 服务端 fetch 命令特性
 * @returns fetch 响应（含 packfile）
 */
export async function negotiateV2Fetch(
  transport: V2GitServiceTransport,
  wants: string[],
  haveCandidates: string[],
  features?: string[],
): Promise<V2FetchResponse> {
  if (wants.length === 0) {
    throw new V2FetchError("No wants specified for fetch");
  }

  // 初始 clone：无 haves，直接发送 wants + done
  if (haveCandidates.length === 0) {
    return v2Fetch(transport, { wants, ofsDelta: true, done: true }, features);
  }

  // 多轮协商
  const state: NegotiationState = {
    sent: new Set(),
    candidates: haveCandidates,
    offset: 0,
    common: [],
  };

  const MAX_ROUNDS = 10;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // 收集本轮 have
    const roundHaves: string[] = [];

    // 先 replay 已确认的 common
    for (const c of state.common) {
      if (!state.sent.has(c)) {
        roundHaves.push(c);
        state.sent.add(c);
      }
    }

    // 再发送新的候选
    let remaining = MAX_HAVES_PER_ROUND - roundHaves.length;
    while (remaining > 0 && state.offset < state.candidates.length) {
      const candidate = state.candidates[state.offset]!;
      state.offset++;
      if (!state.sent.has(candidate)) {
        roundHaves.push(candidate);
        state.sent.add(candidate);
        remaining--;
      }
    }

    const isFinalRound = roundHaves.length === 0 || round === MAX_ROUNDS - 1;

    // 发送请求（不含 done，中间轮）
    const response = await v2Fetch(
      transport,
      { wants, haves: roundHaves, ofsDelta: true },
      features,
    );

    // 解析响应
    const ack = response.acknowledgments;
    if (!ack) {
      // 如果 done 被省略，但服务端直接返回了 packfile
      // （v2 允许服务端在 ready 时发送 packfile）
      if (response.packfile) {
        return response;
      }
      continue;
    }

    // 吸收 ACK
    if (ack.acks.length > 0) {
      for (const ackOid of ack.acks) {
        if (!state.common.includes(ackOid)) {
          state.common.push(ackOid);
        }
      }
    }

    // 服务端 ready → 发送最终请求（带 done）
    if (ack.ready) {
      return v2Fetch(transport, { wants, haves: roundHaves, ofsDelta: true, done: true }, features);
    }

    // 所有 have 已发送完 → 发 done 结束
    if (isFinalRound) {
      return v2Fetch(transport, { wants, haves: roundHaves, ofsDelta: true, done: true }, features);
    }
  }

  // 最大轮数耗尽，强制 done
  return v2Fetch(transport, { wants, ofsDelta: true, done: true }, features);
}

// ============================================================================
// v1 兼容包装：v2FetchObjects
// ============================================================================

/**
 * 使用 v2 fetch 获取对象并写入对象存储
 *
 * 模拟 v1 fetchPack() 的语义，使 import-plan-builder 可无缝切换。
 *
 * @param store - 对象存储（用于写入 packfile 中的对象）
 * @param v2Trans - v2 传输接口
 * @param wants - want 对象哈希列表
 * @param haves - have 对象哈希列表
 * @param features - 服务端 fetch 命令特性
 * @returns 导入的对象数量
 */
export async function v2FetchObjects(
  db: ObjectDatabase,
  v2Trans: V2GitServiceTransport,
  wants: string[],
  haves?: string[],
  features?: string[],
): Promise<{ objectCount: number }> {
  const result = await negotiateV2Fetch(v2Trans, wants, haves ?? [], features);

  if (!result.packfile || result.packfile.length === 0) {
    return { objectCount: 0 };
  }

  // 解析 packfile 并直接摄入原始对象（跳过语义反序列化）
  const reader = createPackReader(result.packfile);
  let count = 0;

  for (const packObj of reader.objects()) {
    db.ingest(packObjectToRaw(packObj));
    count++;
  }

  return { objectCount: count };
}
