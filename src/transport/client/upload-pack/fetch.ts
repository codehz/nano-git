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
import { sha1 } from "../../../types/index.ts";
import {
  encodeDelimiterPkt,
  encodeFlushPkt,
  encodePktLine,
  encodeResponseEndPkt,
  splitPktLinesFromBuffer,
} from "../../protocol/pkt-line.ts";
import { createFetchHaveSelector } from "./fetch-negotiator.ts";

import type { ObjectDatabase } from "../../../odb/types.ts";
import type { ObjectSource } from "../../../types/odb.ts";
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

/** 官方 Git：协商过程中连续无效 have 的容忍上限 */
const MAX_IN_VAIN = 256;

/** 官方 Git：v2 首轮默认发送 16 条 have */
const INITIAL_FLUSH = 16;

/** 官方 Git：stateless-rpc 在此阈值前采用倍增窗口 */
const LARGE_FLUSH = 16384;

/** 侧信道通道编号 */
const CHANNEL_PACKFILE = 0x01;

/** khash 的默认装载上限，Git 的 oidset 直接复用该实现 */
const GIT_OIDSET_HASH_UPPER = 0.77;

/**
 * Git 的 oidhash 直接 memcpy 前 4 字节到 unsigned int。
 *
 * 为了让 v2 协商中的 common replay 顺序贴近官方 Git，这里按宿主字节序
 * 读取 SHA-1 的前 4 个原始字节，模拟 khash/oidset 的桶定位行为。
 */
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;

/** 更贴近官方 Git CLI 的默认 fetch 参数 */
const DEFAULT_NEGOTIATION_FETCH_OPTIONS = {
  thinPack: true,
  noProgress: true,
  includeTag: true,
  ofsDelta: true,
} as const;

interface GitOidSetState {
  buckets: Array<string | undefined>;
  states: Uint8Array;
  size: number;
  occupied: number;
  upperBound: number;
}

function roundUpPowerOfTwo(value: number): number {
  let rounded = 1;
  while (rounded < value) {
    rounded <<= 1;
  }
  return Math.max(4, rounded);
}

function createGitOidSetState(): GitOidSetState {
  return {
    buckets: [],
    states: new Uint8Array(0),
    size: 0,
    occupied: 0,
    upperBound: 0,
  };
}

function readOidHash(oid: string): number {
  const raw = Buffer.from(oid.slice(0, 8), "hex");
  return HOST_IS_LITTLE_ENDIAN ? raw.readUInt32LE(0) : raw.readUInt32BE(0);
}

function resizeGitOidSet(state: GitOidSetState, requestedBuckets: number): void {
  const previousBuckets = state.buckets;
  const previousStates = state.states;
  const previousBucketCount = previousBuckets.length;
  const nextBucketCount = roundUpPowerOfTwo(requestedBuckets);
  const nextStates = new Uint8Array(nextBucketCount);
  const nextBuckets = [...previousBuckets];
  nextBuckets.length = nextBucketCount;
  const nextMask = nextBucketCount - 1;

  for (let index = 0; index < previousBucketCount; index++) {
    if (previousStates[index] !== 1) {
      continue;
    }

    let key = nextBuckets[index]!;
    previousStates[index] = 2;

    while (true) {
      let probe = readOidHash(key) & nextMask;
      let step = 0;
      while (nextStates[probe] !== 0) {
        probe = (probe + ++step) & nextMask;
      }

      nextStates[probe] = 1;

      if (probe < previousBucketCount && previousStates[probe] === 1) {
        const displaced = nextBuckets[probe]!;
        nextBuckets[probe] = key;
        key = displaced;
        previousStates[probe] = 2;
        continue;
      }

      nextBuckets[probe] = key;
      break;
    }
  }

  state.buckets = nextBuckets;
  state.states = nextStates;
  state.occupied = state.size;
  state.upperBound = Math.floor(nextBucketCount * GIT_OIDSET_HASH_UPPER + 0.5);
}

function insertGitOidSet(state: GitOidSetState, oid: string): boolean {
  if (state.occupied >= state.upperBound) {
    const currentBuckets = state.buckets.length;
    if (currentBuckets > state.size << 1) {
      resizeGitOidSet(state, currentBuckets - 1);
    } else {
      resizeGitOidSet(state, currentBuckets + 1);
    }
  }

  const bucketCount = state.buckets.length;
  const mask = bucketCount - 1;
  const hash = readOidHash(oid);
  let slot = bucketCount;
  let deletedSlot = bucketCount;
  let probe = hash & mask;

  if (state.states[probe] === 0) {
    slot = probe;
  } else {
    const start = probe;
    let step = 0;
    while (
      state.states[probe] !== 0 &&
      (state.states[probe] === 2 || state.buckets[probe] !== oid)
    ) {
      if (state.states[probe] === 2) {
        deletedSlot = probe;
      }
      probe = (probe + ++step) & mask;
      if (probe === start) {
        slot = deletedSlot;
        break;
      }
    }

    if (slot === bucketCount) {
      if (state.states[probe] === 0 && deletedSlot !== bucketCount) {
        slot = deletedSlot;
      } else {
        slot = probe;
      }
    }
  }

  if (state.states[slot] === 0) {
    state.buckets[slot] = oid;
    state.states[slot] = 1;
    state.size++;
    state.occupied++;
    return true;
  }

  if (state.states[slot] === 2) {
    state.buckets[slot] = oid;
    state.states[slot] = 1;
    state.size++;
    return true;
  }

  return false;
}

function iterateGitOidSet(state: GitOidSetState): string[] {
  const result: string[] = [];
  for (let index = 0; index < state.buckets.length; index++) {
    if (state.states[index] === 1) {
      result.push(state.buckets[index]!);
    }
  }
  return result;
}

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
  const useSidebandAll = params.sidebandAll === true && hasFeature("sideband-all");

  // 构建 arguments（所有 fetch 参数都在分隔符之后）
  const args: string[] = [];

  // 传输参数（thin-pack、ofs-delta 等是 v2 fetch 的 argument，不是 capability）
  if (params.thinPack) args.push("thin-pack");
  if (params.noProgress) args.push("no-progress");
  if (params.includeTag) args.push("include-tag");
  if (params.ofsDelta) args.push("ofs-delta");
  if (useSidebandAll) args.push("sideband-all");
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

  // have 列表：即使带 done，协议也允许同时发送 have 终止协商。
  if (params.haves) {
    for (const oid of params.haves) {
      args.push(`have ${oid}`);
    }
  }

  // done 标记
  if (params.done) {
    args.push("done");
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

  return parseV2FetchResponse(response, params.done ?? false, useSidebandAll);
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
  void _hasDone;
  if (sidebandAll) {
    return parseV2FetchResponse(demultiplexSidebandAll(data), _hasDone, false);
  }

  // 使用 splitPktLinesFromBuffer 优雅处理尾部非 pkt-line 数据
  const { lines: pktLines, trailing } = splitPktLinesFromBuffer(data);

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

function demultiplexSidebandAll(data: Buffer): Buffer {
  const { lines } = splitPktLinesFromBuffer(data);
  const parts: Buffer[] = [];
  let inPackfile = false;

  for (const pkt of lines) {
    switch (pkt.type) {
      case "flush":
        parts.push(encodeFlushPkt());
        inPackfile = false;
        continue;
      case "delimiter":
        parts.push(encodeDelimiterPkt());
        inPackfile = false;
        continue;
      case "response-end":
        parts.push(encodeResponseEndPkt());
        continue;
      case "data": {
        if (pkt.payload.length === 0) {
          continue;
        }
        const channel = pkt.payload[0]!;
        const payload = pkt.payload.subarray(1);
        if (inPackfile) {
          parts.push(encodePktLine(Buffer.concat([Buffer.from([channel]), payload])));
          continue;
        }
        if (channel === 0x01) {
          parts.push(encodePktLine(payload));
          if (payload.equals(Buffer.from("packfile\n"))) {
            inPackfile = true;
          }
          continue;
        }
        if (channel === 0x02) {
          continue;
        }
        if (channel === 0x03) {
          throw new V2FetchError(`remote fatal: ${payload.toString("utf-8").trim()}`);
        }
        continue;
      }
    }
  }

  return Buffer.concat(parts);
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
    } else if (channel === 0x03) {
      throw new V2FetchError(`remote fatal: ${frame.subarray(1).toString("utf-8").trim()}`);
    }
    // channel 2 为进度消息，忽略
  }

  if (chunks.length === 0) {
    throw new V2FetchError("No packfile data found in fetch response");
  }

  return Buffer.concat(chunks);
}

// ============================================================================
// 多轮协商
// ============================================================================

function nextFlush(count: number): number {
  if (count < LARGE_FLUSH) {
    return count << 1;
  }
  return Math.floor((count * 11) / 10);
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
 * @param haveCandidates - have 候选列表（通常为本地 refs tip）
 * @param features - 服务端 fetch 命令特性
 * @param localObjects - 本地对象源（可选，用于 commit-aware negotiator）
 * @param knownCommonRefs - 已知与远端相同的远端 ref 提示（可选）
 * @returns fetch 响应（含 packfile）
 */
export async function negotiateV2Fetch(
  transport: V2GitServiceTransport,
  wants: string[],
  haveCandidates: string[],
  features?: string[],
  localObjects?: ObjectSource,
  knownCommonRefs?: readonly string[],
): Promise<V2FetchResponse> {
  if (wants.length === 0) {
    throw new V2FetchError("No wants specified for fetch");
  }

  // 初始 clone：无 haves，直接发送 wants + done
  if (haveCandidates.length === 0) {
    return v2Fetch(
      transport,
      {
        wants,
        ...DEFAULT_NEGOTIATION_FETCH_OPTIONS,
        done: true,
      },
      features,
    );
  }

  const selector = createFetchHaveSelector(haveCandidates, localObjects, knownCommonRefs);
  const commonSet = createGitOidSetState();
  let havesToSend = INITIAL_FLUSH;
  let inVain = 0;
  let seenAck = false;

  while (true) {
    const roundHaves = iterateGitOidSet(commonSet);
    let havesAdded = 0;

    while (havesAdded < havesToSend) {
      const nextHave = selector.next();
      if (!nextHave) {
        break;
      }
      roundHaves.push(nextHave);
      havesAdded++;
    }

    havesToSend = nextFlush(havesToSend);
    inVain += havesAdded;

    const done = havesAdded === 0 || (seenAck && inVain >= MAX_IN_VAIN);
    const response = await v2Fetch(
      transport,
      { wants, haves: roundHaves, ...DEFAULT_NEGOTIATION_FETCH_OPTIONS, done },
      features,
    );

    // 官方 Git 在 ready 响应中会直接携带 packfile，客户端必须立即消费。
    if (response.packfile) {
      return response;
    }

    if (done) {
      return response;
    }

    const ack = response.acknowledgments;
    if (!ack) {
      throw new V2FetchError("Missing acknowledgments in negotiation response");
    }

    if (ack.acks.length > 0) {
      seenAck = true;
      inVain = 0;

      for (const ackOid of ack.acks) {
        selector.ack(sha1(ackOid));
        insertGitOidSet(commonSet, ackOid);
      }
    }

    // 规范要求 ready 响应应与 packfile 同帧返回；若对端实现更保守，
    // 则补发一轮带 done 的请求兜底。
    if (ack.ready) {
      return v2Fetch(
        transport,
        {
          wants,
          haves: iterateGitOidSet(commonSet),
          ...DEFAULT_NEGOTIATION_FETCH_OPTIONS,
          done: true,
        },
        features,
      );
    }

    selector.releaseAncestors();
  }
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
 * @param knownCommonRefs - 已知与远端相同的远端 ref 提示（可选）
 * @returns 导入的对象数量
 */
export async function v2FetchObjects(
  db: ObjectDatabase,
  v2Trans: V2GitServiceTransport,
  wants: string[],
  haves?: string[],
  features?: string[],
  knownCommonRefs?: readonly string[],
): Promise<{ objectCount: number }> {
  const result = await negotiateV2Fetch(v2Trans, wants, haves ?? [], features, db, knownCommonRefs);

  if (!result.packfile || result.packfile.length === 0) {
    return { objectCount: 0 };
  }

  // 解析 packfile 并直接摄入原始对象（跳过语义反序列化）
  const reader = createPackReader(result.packfile, db);
  let count = 0;

  for (const packObj of reader.objects()) {
    db.ingest(packObjectToRaw(packObj));
    count++;
  }

  return { objectCount: count };
}
