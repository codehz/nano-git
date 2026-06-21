/**
 * 高层 fetch 编排
 *
 * 编排完整的 Smart HTTP fetch 流程：
 * 1. 获取远程引用广告
 * 2. 按 refspec 确定要拉取的引用
 * 3. 构造 upload-pack 请求
 * 4. 解析 packfile 并写入本地存储
 * 5. 更新远程跟踪引用
 *
 * @example
 * ```ts
 * import { initRepository } from "./repository/index.ts";
 * import { fetch } from "./transport/fetch.ts";
 *
 * const repo = initRepository("/tmp/my-repo");
 * const result = await fetch(repo.objects, repo.refs, "https://github.com/user/repo");
 * console.log(`Fetched ${result.objectCount} objects`);
 * ```
 */

import { GitError } from "../core/errors.ts";
import { sha1 } from "../core/types.ts";
import { deserializeContent } from "../objects/codec.ts";
import { createPackReader } from "../odb/pack/pack-reader.ts";
import { resolveRefHash } from "../refs/resolve.ts";
import { HEADS_PREFIX, TAGS_PREFIX, HEAD_REF } from "../refs/types.ts";
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
import { isAncestor } from "./push.ts";
import { createSmartHttpClient } from "./smart-http.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectStore } from "../odb/types.ts";
import type { RefStore } from "../refs/types.ts";
import type { FetchOptions, FetchResult } from "./types.ts";
import type { RemoteRef } from "./types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * Fetch 操作错误
 */
export class FetchError extends GitError {
  constructor(message: string) {
    super(`Fetch error: ${message}`);
    this.name = "FetchError";
  }
}

// ============================================================================
// 常量
// ============================================================================

/** 默认 refspec */
const DEFAULT_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

/** Have 候选集默认预算上限 */
const DEFAULT_MAX_CANDIDATES = 512;

/** Git 协议 v1 常用能力 */
const DEFAULT_CAPABILITIES = [
  "multi_ack",
  "side-band-64k",
  "ofs-delta",
  "no-progress",
  "include-tag",
  "shallow",
];

// ============================================================================
// 辅助类型
// ============================================================================

/** 解析后的 refspec */
export interface ParsedRefSpec {
  force: boolean;
  srcPattern: string;
  dstPattern: string;
  /** 原始 refspec 是否包含通配符 * */
  isWildcard: boolean;
}

// ============================================================================
// RefSpec 解析
// ============================================================================

/**
 * 解析 refspec 字符串
 *
 * 格式: [+]<src>:<dst>
 * 其中 + 表示 force push/fetch
 * * 是通配符
 *
 * @example
 * ```ts
 * parseRefSpec("+refs/heads/*:refs/remotes/origin/*")
 * // => { force: true, srcPattern: "refs/heads/", dstPattern: "refs/remotes/origin/", isWildcard: true }
 * ```
 */
export function parseRefSpec(refSpec: string): ParsedRefSpec {
  const force = refSpec.startsWith("+");
  const spec = force ? refSpec.slice(1) : refSpec;

  const colonIndex = spec.indexOf(":");
  if (colonIndex === -1) {
    throw new FetchError(`Invalid refspec: "${refSpec}" (missing ":")`);
  }

  const src = spec.substring(0, colonIndex);
  const dst = spec.substring(colonIndex + 1);

  // 是否包含通配符（* 只允许出现在末尾，由外层调用确保）
  const isWildcard = src.endsWith("*") && dst.endsWith("*");

  // 处理通配符：去掉尾部 *
  const srcPattern = src.replace(/\*$/, "");
  const dstPattern = dst.replace(/\*$/, "");

  return { force, srcPattern, dstPattern, isWildcard };
}

/**
 * 判断远程引用是否匹配 refspec 源模式
 *
 * 通配符 refspec 使用 startsWith 匹配前缀，
 * 精确 refspec 需要完全相等。
 */
export function matchesRefSpec(ref: RemoteRef, spec: ParsedRefSpec): boolean {
  if (spec.isWildcard) {
    return ref.name.startsWith(spec.srcPattern);
  }
  return ref.name === spec.srcPattern;
}

/**
 * 将远程引用名转换为本地引用名
 */
export function mapRefName(refName: string, spec: ParsedRefSpec): string {
  const suffix = refName.slice(spec.srcPattern.length);
  return `${spec.dstPattern}${suffix}`;
}

/**
 * 按 refspec 过滤远程引用并确定 wants
 *
 * @param remoteRefs - 远程引用列表
 * @param localRefs - 本地 ref → hash 映射
 * @param refSpecs - refspec 列表
 * @returns wants（需要拉取的远程引用及其本地 ref 名）
 */
export function determineWants(
  remoteRefs: RemoteRef[],
  localRefs: Map<string, SHA1>,
  refSpecs: ParsedRefSpec[],
): Array<{ remote: RemoteRef; localName: string; localHash?: SHA1; force: boolean }> {
  const wants: Array<{ remote: RemoteRef; localName: string; localHash?: SHA1; force: boolean }> =
    [];

  for (const ref of remoteRefs) {
    for (const spec of refSpecs) {
      if (!matchesRefSpec(ref, spec)) continue;

      const localName = mapRefName(ref.name, spec);

      // 检查本地是否已是最新
      const localHash = localRefs.get(localName);
      if (localHash === ref.hash) {
        continue; // 已是最新，跳过
      }

      wants.push({ remote: ref, localName, localHash, force: spec.force });
    }
  }

  return wants;
}

/**
 * 获取本地 refs 的哈希映射
 *
 * 遍历 refs/heads/、refs/tags/ 和 HEAD 等已知前缀，
 * 避免使用 "refs/" 顶级前缀（不满足 validateRefPrefix 要求）。
 */
export function getLocalRefs(refs: RefStore): Map<string, SHA1> {
  const map = new Map<string, SHA1>();
  const prefixes = [HEADS_PREFIX, TAGS_PREFIX, "refs/remotes/"];

  // 明确检查的引用
  const explicitRefs = [HEAD_REF];

  for (const prefix of prefixes) {
    for (const refName of refs.listRaw(prefix)) {
      const content = refs.readRaw(refName);
      if (content && /^[0-9a-f]{40}$/.test(content)) {
        try {
          map.set(refName, sha1(content));
        } catch {
          // 忽略无效哈希
        }
      }
    }
  }

  for (const refName of explicitRefs) {
    try {
      const hash = resolveRefHash(refs, refName);
      if (hash) {
        map.set(refName, hash);
      }
    } catch {
      // 忽略解析失败（如循环引用）
    }
  }

  return map;
}

// ============================================================================
// Fetch 编排
// ============================================================================

/**
 * 执行 fetch 操作
 *
 * 从远程 Git 仓库拉取对象和引用更新。
 *
 * @param store - 本地对象存储
 * @param refs - 本地引用存储
 * @param url - 远程仓库 URL（如 "https://github.com/user/repo"）
 * @param options - 可选配置
 * @returns fetch 操作结果
 *
 * @example
 * ```ts
 * const result = await fetch(repo.objects, repo.refs, "https://github.com/user/repo");
 * console.log(`Fetched ${result.objectCount} objects`);
 * ```
 */
export async function fetch(
  store: ObjectStore,
  refs: RefStore,
  url: string,
  options?: FetchOptions,
): Promise<FetchResult> {
  const client =
    options?.transport ??
    createSmartHttpClient(url, {
      token: options?.token,
      headers: options?.headers,
    });

  // 1. 获取远程引用广告
  const adv = await client.getRefAdvertisement();

  // 2. 解析 refspec
  const refSpecStr = options?.refSpecs ?? [DEFAULT_REFSPEC];
  const parsedSpecs = refSpecStr.map(parseRefSpec);

  // 3. 获取本地 refs
  const localRefs = getLocalRefs(refs);

  // 4. 确定 wants
  const wants = determineWants(adv.refs, localRefs, parsedSpecs);

  if (wants.length === 0) {
    return {
      fetchedRefs: new Map(),
      objectCount: 0,
    };
  }

  // 5. 从服务端 capabilities 中确定可用能力
  const caps = extractCapabilities(adv.capabilities);

  // 6. 构造请求：裁剪后的 Consecutive 协商算法
  //
  //    从相关 remote-tracking refs 出发收集 have 候选，
  //    减少无关本地分支/标签带来的噪音。
  //    支持 maxCandidates 预算限制候选集大小。
  const wantHashes = wants.map((w) => w.remote.hash);

  // 使用 selectHaveTips 按优先级选择遍历起点：
  // 1. wants 对应的 remote-tracking ref 旧值
  // 2. 同一远端命名空间下的其他 remote-tracking refs
  // 3. HEAD
  // 4. 本地 heads（兜底）
  const haveTips = selectHaveTips(localRefs, wants);
  const maxCandidates = options?.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const haveHashes =
    haveTips.length > 0 ? collectHaveCommits(store, haveTips, { maxCandidates }) : [];
  // 7. 发送请求
  const {
    packfile,
    shallow: newShallow,
    unshallow: newUnshallow,
  } = await negotiateAndFetchPackfile(
    client,
    wantHashes,
    haveHashes,
    caps,
    options?.depth,
    options?.shallow,
  );

  if (packfile.length === 0) {
    throw new FetchError("Server returned empty packfile");
  }

  // 8. 解析 packfile 并写入对象
  const reader = createPackReader(packfile);
  let objectCount = 0;

  for (const packObj of reader.objects()) {
    try {
      const gitObj = deserializeContent(packObj.type, packObj.data);
      store.write(gitObj);
      objectCount++;
    } catch (err) {
      // 如果某个对象写入失败，继续处理其余对象
      // 但记录错误以便调试
      if (err instanceof Error) {
        throw new FetchError(`Failed to write object ${packObj.hash}: ${err.message}`);
      }
    }
  }

  // 9. 更新远程跟踪引用（非强制 refspec 需满足快进条件）
  const fetchedRefs = new Map<string, SHA1>();
  for (const { localName, remote, localHash, force } of wants) {
    // 非强制且本地已有值：仅当更新为快进时才写入
    if (!force && localHash !== undefined) {
      if (!isAncestor(store, localHash, remote.hash)) {
        continue; // 非快进，跳过此 ref 的更新
      }
    }
    refs.writeRaw(localName, remote.hash);
    fetchedRefs.set(localName, remote.hash);
  }

  return {
    fetchedRefs,
    objectCount,
    shallow: newShallow.length > 0 ? newShallow : undefined,
    unshallow: newUnshallow.length > 0 ? newUnshallow : undefined,
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从服务端 capabilities 中提取客户端可用的能力列表
 *
 * 客户端声明它想要的能力，服务端在响应中报告它支持的能力。
 * 这里取客户端默认能力与服务端支持能力的交集。
 */
function extractCapabilities(serverCaps: Record<string, string | true>): string[] {
  const supported = new Set<string>(DEFAULT_CAPABILITIES);
  // 只使用服务端也支持的能力
  return Object.keys(serverCaps).filter((cap) => supported.has(cap));
}

/**
 * 选择 have 遍历起点
 *
 * 根据 wants 和本地 refs 确定用于 have 收集的起点哈希列表。
 * 优先级：
 *  1. wants 对应的 remote-tracking ref 旧值（如 refs/remotes/origin/main）
 *  2. 同一远端命名空间下的其他 remote-tracking refs
 *  3. HEAD
 *  4. 本地 refs/heads/*（兜底）
 *
 * @param localRefs - 所有本地 ref → hash 映射
 * @param wants - 将要拉取的 wants（含 localName、localHash 和 force）
 * @returns 适合作为 have 遍历起点的哈希列表
 *
 * @example
 * ```ts
 * const tips = selectHaveTips(localRefs, wants);
 * ```
 */
export function selectHaveTips(
  localRefs: Map<string, SHA1>,
  wants: Array<{ remote: RemoteRef; localName: string; localHash?: SHA1; force: boolean }>,
): SHA1[] {
  const tips: SHA1[] = [];
  const seen = new Set<SHA1>();

  // 第一优先：wants 对应的 remote-tracking ref 旧值
  for (const w of wants) {
    if (w.localHash && !seen.has(w.localHash)) {
      seen.add(w.localHash);
      tips.push(w.localHash);
    }
  }

  // 推导远端命名空间前缀
  const remotePrefixes = new Set<string>();
  for (const w of wants) {
    const m = w.localName.match(/^(refs\/remotes\/[^/]+\/)/);
    if (m) {
      remotePrefixes.add(m[1]!);
    }
  }

  // 第二优先：同一远端命名空间下的其他 remote-tracking refs
  for (const [refName, hash] of localRefs) {
    if (seen.has(hash)) continue;
    if (refName.startsWith("refs/remotes/")) {
      // 如果已知远端前缀，只取匹配的；否则取所有 remote-tracking refs
      if (remotePrefixes.size === 0 || [...remotePrefixes].some((p) => refName.startsWith(p))) {
        seen.add(hash);
        tips.push(hash);
      }
    }
  }

  // 第三优先：HEAD
  const headHash = localRefs.get("HEAD");
  if (headHash && !seen.has(headHash)) {
    seen.add(headHash);
    tips.push(headHash);
  }

  // 第四优先：本地 heads（兜底）
  for (const [refName, hash] of localRefs) {
    if (seen.has(hash)) continue;
    if (refName.startsWith("refs/heads/")) {
      seen.add(hash);
      tips.push(hash);
    }
  }

  return tips;
}

/**
 * 执行多轮 stateless-rpc 协商并返回最终 packfile 及 shallow 信息
 *
 * 多轮语义：
 * - 每轮 HTTP POST 都是独立的，服务端不维持状态
 * - 每轮重发完整前缀（want/deepen/shallow）
 * - 已确认 common 的 have 在后续轮次中重放（无需重放全部历史 have）
 * - 最终轮以 done 结尾，中间轮以 flush 结尾
 * - shallow/unshallow 跨轮累计
 */
async function negotiateAndFetchPackfile(
  client: import("./types.ts").RemoteTransport,
  wants: SHA1[],
  haves: SHA1[],
  capabilities: string[],
  depth?: number,
  shallow?: SHA1[],
): Promise<{ packfile: Buffer; shallow: SHA1[]; unshallow: SHA1[] }> {
  // 构建固定前缀（包含 want/deepen/shallow + flush）
  //
  // shallow 边界无论是否 deepen 都应发送：服务端需要知道客户端
  // 已将哪些 commit 标记为 shallow，才能正确判断公共祖先和生成 unshallow。
  const prefix = buildUploadPackRequestPrefix({
    wants,
    capabilities,
    depth,
    shallow,
  });

  const state = createNegotiationState();

  // 辅助函数：发送一轮请求并解析响应
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

    // 累计 shallow/unshallow 信息
    mergeShallowInfo(state, response);

    // 吸收 ACK common/ready 到 replay 集合
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

    // 如果服务端返回了 packfile，直接返回
    if (packfile.length > 0) {
      return { packfile, shallow: state.shallow, unshallow: state.unshallow };
    }

    // 如果服务端说 "ready"，立即发最终 done 请求
    if (response.acknowledgements.some((a) => a.status === "ready")) {
      const { packfile: finalPackfile } = await sendRound(state.commonToReplay, [], true);
      return {
        packfile: finalPackfile,
        shallow: state.shallow,
        unshallow: state.unshallow,
      };
    }

    // 如果是最后一轮且服务端仍未返回 packfile，维持当前行为
    if (isLast) {
      return { packfile, shallow: state.shallow, unshallow: state.unshallow };
    }

    // 继续下一轮
  }
}
