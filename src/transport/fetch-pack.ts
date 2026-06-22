/**
 * 协商 upload-pack 并写入对象库
 *
 * 接收明确的 wants，基于本地 refs 选择 have 候选，
 * 执行多轮 negotiation，解包并写入对象库。
 *
 * fetchPack() 不再自己创建传输层实例或获取 advertisement ——
 * 这些由调用方在外部完成并通过参数传入。
 *
 * 此模块只写对象库，不写 ref，不依赖 remote-tracking 命名空间之外的仓库语义。
 *
 * @example
 * ```ts
 * const transport = createUploadPackHttpClient(url);
 * const adv = await transport.getRefAdvertisement();
 * const result = await fetchPack(objects, transport, adv, {
 *   wants: [sha1("95d09f2b...")],
 * });
 * console.log(`Fetched ${result.objectCount} objects`);
 * ```
 */

import { GitError } from "../core/errors.ts";
import { deserializeContent } from "../objects/codec.ts";
import { createPackReader } from "../odb/pack/pack-reader.ts";
import {
  buildUploadPackRequestPrefix,
  buildUploadPackNegotiationRequest,
  collectHaveCommits,
  createNegotiationState,
  absorbAckCommon,
  mergeShallowInfo,
  nextHaveChunk,
  MAX_HAVES_PER_ROUND,
  parseUploadPackNegotiationResponse,
} from "./negotiate.ts";
import { extractCapabilities, FETCH_CAPABILITIES } from "./transport-capabilities.ts";

import type { SHA1, GitObject } from "../core/types.ts";
import type { ObjectStore } from "../odb/types.ts";
import type {
  UploadPackTransport,
  RefAdvertisement,
  FetchPackOptions,
  FetchPackResult,
} from "./types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * Fetch-pack 操作错误
 */
export class FetchPackError extends GitError {
  constructor(message: string) {
    super(`Fetch-pack error: ${message}`);
    this.name = "FetchPackError";
  }
}

// ============================================================================
// 多轮 stateless-rpc 协商
// ============================================================================

/**
 * 执行多轮 stateless-rpc 协商并返回最终 packfile 及 shallow 信息
 *
 * 多轮语义：
 * - 每轮 HTTP POST 都是独立的，服务端不维持状态
 * - 每轮重发完整前缀（want/deepen/shallow）
 * - 已确认 common 的 have 在后续轮次中重放
 * - 最终轮以 done 结尾，中间轮以 flush 结尾
 * - shallow/unshallow 跨轮累计
 */
async function negotiateAndFetchPackfile(
  client: UploadPackTransport,
  wants: SHA1[],
  haves: SHA1[],
  capabilities: string[],
  depth?: number,
  shallow?: SHA1[],
): Promise<{ packfile: Buffer; shallow: SHA1[]; unshallow: SHA1[] }> {
  const prefix = buildUploadPackRequestPrefix({
    wants,
    capabilities,
    depth,
    shallow,
  });

  const state = createNegotiationState();

  async function sendRound(
    replayHaves: SHA1[],
    newHaves: SHA1[],
    done: boolean,
  ): Promise<{
    response: import("./negotiate.ts").UploadPackNegotiationResponse;
    packfile: Buffer;
  }> {
    const body = buildUploadPackNegotiationRequest(prefix, replayHaves, newHaves, done);
    const { data, packfile } = await client.postUploadPack(body);
    const response = parseUploadPackNegotiationResponse(data);

    mergeShallowInfo(state, response);

    for (const ack of response.acknowledgements) {
      absorbAckCommon(state, ack);
    }

    return { response, packfile };
  }

  // 初始 clone：无 haves，直接发 done 请求
  if (haves.length === 0) {
    const { packfile } = await sendRound([], [], true);
    return { packfile, shallow: state.shallow, unshallow: state.unshallow };
  }

  // 多轮增量协商
  while (true) {
    const newChunk = nextHaveChunk(haves, state, MAX_HAVES_PER_ROUND);
    const isLast = state.offset >= haves.length;

    const { response, packfile } = await sendRound(state.commonToReplay, newChunk, isLast);

    if (packfile.length > 0) {
      return { packfile, shallow: state.shallow, unshallow: state.unshallow };
    }

    if (response.acknowledgements.some((a) => a.status === "ready")) {
      const { packfile: finalPackfile } = await sendRound(state.commonToReplay, [], true);
      return {
        packfile: finalPackfile,
        shallow: state.shallow,
        unshallow: state.unshallow,
      };
    }

    if (isLast) {
      return { packfile, shallow: state.shallow, unshallow: state.unshallow };
    }
  }
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 执行 fetch-pack 操作
 *
 * 只负责传输层协商与对象写入，不负责：
 * - 创建传输层客户端（由调用方传入）
 * - 获取 advertisement（由调用方传入）
 * - ref 映射与更新
 *
 * @param store - 本地对象存储
 * @param transport - upload-pack 传输接口
 * @param advertisement - 服务端广告（含 capabilities 和 refs）
 * @param options - fetch-pack 选项（wants、haves、depth、shallow）
 * @returns fetch-pack 结果
 *
 * @example
 * ```ts
 * const transport = createUploadPackHttpClient(url);
 * const adv = await transport.getRefAdvertisement();
 * const result = await fetchPack(objects, transport, adv, {
 *   wants: [sha1("95d09f2b...")],
 * });
 * ```
 */
export async function fetchPack(
  store: ObjectStore,
  transport: UploadPackTransport,
  advertisement: RefAdvertisement,
  options: FetchPackOptions,
): Promise<FetchPackResult> {
  // 1. 解析能力
  const caps = extractCapabilities(advertisement.capabilities, FETCH_CAPABILITIES);

  // 2. shallow 能力校验
  const hasShallowCap = caps.includes("shallow");
  if (!hasShallowCap && (options.depth !== undefined || (options.shallow ?? []).length > 0)) {
    throw new FetchPackError(
      "Server does not support shallow fetch (shallow capability not advertised), " +
        "but depth or shallow options were specified.",
    );
  }

  // 3. 收集 have 候选
  const haveHashes =
    options.haves && options.haves.length > 0
      ? collectHaveCommits(store, options.haves, { maxCandidates: options.maxCandidates })
      : [];

  // 4. 发送请求
  const {
    packfile,
    shallow: newShallow,
    unshallow: newUnshallow,
  } = await negotiateAndFetchPackfile(
    transport,
    options.wants,
    haveHashes,
    caps,
    options.depth,
    options.shallow,
  );

  if (packfile.length === 0) {
    throw new FetchPackError("Server returned empty packfile");
  }

  // 5. 解析 packfile 并写入对象
  const reader = createPackReader(packfile);
  const pendingObjects: Array<{ hash: SHA1; obj: GitObject }> = [];

  for (const packObj of reader.objects()) {
    const gitObj = deserializeContent(packObj.type, packObj.data);
    pendingObjects.push({ hash: packObj.hash, obj: gitObj });
  }

  for (const { obj } of pendingObjects) {
    store.write(obj);
  }

  const objectCount = pendingObjects.length;

  return {
    objectCount,
    shallow: newShallow.length > 0 ? newShallow : undefined,
    unshallow: newUnshallow.length > 0 ? newUnshallow : undefined,
  };
}
