/**
 * v2 fetch 命令响应生成
 *
 * 处理 fetch 命令，计算对象集合、构建 packfile、生成 fetch 响应。
 *
 * @see https://git-scm.com/docs/protocol-v2#_fetch
 */

import { sha1 } from "../../../core/types.ts";
import { createPackWriter } from "../../../pack/pack-writer.ts";
import { resolveRefHash } from "../../../refs/resolve.ts";
import { collectReachable } from "../../shared/object-graph.ts";
import { encodePktLine, encodeFlushPkt, encodeDelimiterPkt } from "../../shared/pkt-line.ts";
import { CHANNEL_PACKFILE, CHANNEL_FATAL, MAX_PKT_PAYLOAD, V2ServeError } from "./types.ts";

import type { RepositoryBackend } from "../../../backend/types.ts";
import type { SHA1 } from "../../../core/types.ts";

/** 从 fetch 请求 args 中解析的参数 */
export interface FetchServerParams {
  readonly wants: SHA1[];
  readonly haves: SHA1[];
  readonly wantRefs: string[];
  readonly done: boolean;
  readonly thinPack: boolean;
  readonly noProgress: boolean;
  readonly ofsDelta: boolean;
}

/**
 * 从 args 中解析 fetch 参数
 *
 * @param args - fetch 命令的 args 列表
 * @returns 结构化的 fetch 参数
 *
 * @example
 * ```ts
 * const params = parseFetchArgs(["want <oid>", "have <oid>", "done"]);
 * // { wants: [<oid>], haves: [<oid>], done: true, ... }
 * ```
 */
export function parseFetchArgs(args: string[]): FetchServerParams {
  const wants: SHA1[] = [];
  const haves: SHA1[] = [];
  const wantRefs: string[] = [];
  let done = false;
  let thinPack = false;
  let noProgress = false;
  let ofsDelta = false;

  for (const arg of args) {
    if (arg === "done") {
      done = true;
    } else if (arg === "thin-pack") {
      thinPack = true;
    } else if (arg === "no-progress") {
      noProgress = true;
    } else if (arg === "ofs-delta") {
      ofsDelta = true;
    } else if (arg.startsWith("want ")) {
      wants.push(sha1(arg.slice(5).trim()));
    } else if (arg.startsWith("have ")) {
      haves.push(sha1(arg.slice(5).trim()));
    } else if (arg.startsWith("want-ref ")) {
      wantRefs.push(arg.slice(9).trim());
    }
    // shallow/deepen/filter 等参数暂时忽略
    // （shallow 场景下支持传递边界但不做剪裁）
  }

  return { wants, haves, wantRefs, done, thinPack, noProgress, ofsDelta };
}

// ============================================================================
// 对象集合计算
// ============================================================================

/**
 * 计算要打包的对象集合
 *
 * - 无 haves（clone）：返回所有 want 对象及其可达对象
 * - 有 haves（增量 fetch）：返回 want 可达对象与 have 可达对象的差集
 */
function computeObjectsToPack(backend: RepositoryBackend, params: FetchServerParams): Set<SHA1> {
  if (params.haves.length === 0) {
    return collectReachable(backend.objects, params.wants, "skip-commit-parents");
  }

  // 增量 fetch：A - B
  const wantReachable = collectReachable(backend.objects, params.wants, "skip-commit-parents");
  const haveReachable = collectReachable(backend.objects, params.haves, "skip-commit-parents");

  const result = new Set<SHA1>();
  for (const hash of wantReachable) {
    if (!haveReachable.has(hash)) {
      result.add(hash);
    }
  }
  return result;
}

// ============================================================================
// side-band 编码
// ============================================================================

/**
 * 将 packfile 数据以 side-band channel 1 格式分帧
 *
 * 每个 pkt-line 帧：<4字节长度><1字节channel><数据>
 */
function encodePackfileWithSideBand(packfile: Buffer): Buffer[] {
  const maxPayload = MAX_PKT_PAYLOAD - 1; // 1 byte for channel
  const frames: Buffer[] = [];
  let offset = 0;

  while (offset < packfile.length) {
    const chunkSize = Math.min(maxPayload, packfile.length - offset);
    const frame = Buffer.alloc(1 + chunkSize);
    frame[0] = CHANNEL_PACKFILE;
    packfile.copy(frame, 1, offset, offset + chunkSize);
    frames.push(encodePktLine(frame));
    offset += chunkSize;
  }

  return frames;
}

// ============================================================================
// fetch 响应生成
// ============================================================================

/**
 * 生成带 packfile 的 fetch 响应
 *
 * 响应结构遵循 protocol-v2（节之间以 delim-pkt 分隔，最后以 flush-pkt 收尾）：
 * ```
 * [acknowledgments\n ACK...\n ready\n 0001]    ← 仅协商命中 ready 时（无 done）
 * [wanted-refs\n <oid> <refname>\n ... 0001]   ← 仅当客户端使用 want-ref
 * packfile\n
 * <side-band 编码的 packfile 数据>
 * 0000
 * ```
 *
 * 注意：
 * - 当请求带 `done`（无 acknowledgments 节）时，section 不应以 delim-pkt 开头——
 *   首节直接是 wanted-refs 或 packfile。早期实现错误地在 packfile 前加了 leading
 *   delim-pkt，导致 git CLI 报 `fatal: expected 'packfile'`。
 * - 当协商阶段（无 done）服务端判定 ready 时，必须在 **同一响应** 中
 *   acknowledgments 节之后紧接 packfile，否则 git 报
 *   `fatal: expected packfile after 'ready'`。
 *
 * @param wantedRefs - want-ref 解析出的 refname→oid 映射（无则不发 wanted-refs 节）
 * @param ackSection - 可选的 acknowledgments 节内容（不含分隔 delim）；提供时会在其后补一个 delim-pkt
 */
function generatePackfileResponse(
  backend: RepositoryBackend,
  params: FetchServerParams,
  wantedRefs: ReadonlyArray<{ refname: string; oid: SHA1 }>,
  ackSection?: Buffer,
): Buffer {
  const parts: Buffer[] = [];

  // acknowledgments 节（仅协商命中 ready 时）：与后续节之间以 delim-pkt 分隔。
  if (ackSection !== undefined) {
    parts.push(ackSection);
    parts.push(encodeDelimiterPkt());
  }

  // wanted-refs 节：当客户端通过 want-ref 请求时必须回送 refname→oid 映射，
  // 否则 git 无法得知每个 ref 解析到的对象。该节后接 delim-pkt 与 packfile 节分隔。
  if (wantedRefs.length > 0) {
    parts.push(encodePktLine("wanted-refs\n"));
    for (const { refname, oid } of wantedRefs) {
      parts.push(encodePktLine(`${oid} ${refname}\n`));
    }
    parts.push(encodeDelimiterPkt());
  }

  // 计算要发送的对象集合
  const toPack = computeObjectsToPack(backend, params);

  // 构建 packfile
  const writer = createPackWriter();
  for (const hash of toPack) {
    const obj = backend.objects.tryRead(hash);
    if (obj) {
      writer.addObject(obj);
    }
  }

  const packfile = writer.build();

  // packfile 节
  parts.push(encodePktLine("packfile\n"));

  // side-band 编码的 packfile 数据
  if (packfile.length > 0) {
    parts.push(...encodePackfileWithSideBand(packfile));
  }

  parts.push(encodeFlushPkt());

  return Buffer.concat(parts);
}

/**
 * 查找 wants 与 haves 间的共同对象
 *
 * 当前简化实现：返回所有在本地仓库中存在且出现在 haves 中的哈希。
 * 更完善的实现应通过 commit 图 BFS 验证祖先关系。
 */
function findCommonObjects(
  backend: RepositoryBackend,
  _wants: SHA1[],
  haves: SHA1[],
): { common: SHA1[]; ready: boolean } {
  const common: SHA1[] = [];

  for (const have of haves) {
    if (backend.objects.exists(have)) {
      common.push(have);
    }
  }

  // 只要有一个 have 在本地仓库中存在就 ready
  const ready = common.length > 0;

  return { common, ready };
}

/**
 * 构建 acknowledgments 节内容（不含尾部 flush/delim）
 *
 * ```
 * acknowledgments\n
 * NAK\n
 * --- 或 ---
 * acknowledgments\n
 * ACK <oid>\n
 * ready\n
 * ```
 *
 * @returns section 内容及是否 ready
 */
function buildAcknowledgmentsSection(
  backend: RepositoryBackend,
  params: FetchServerParams,
): { section: Buffer; ready: boolean } {
  const parts: Buffer[] = [];
  parts.push(encodePktLine("acknowledgments\n"));

  const { common, ready } = findCommonObjects(backend, params.wants, params.haves);

  if (common.length > 0) {
    for (const oid of common) {
      parts.push(encodePktLine(`ACK ${oid}\n`));
    }
    if (ready) {
      parts.push(encodePktLine("ready\n"));
    }
  } else {
    parts.push(encodePktLine("NAK\n"));
  }

  return { section: Buffer.concat(parts), ready };
}

/**
 * 生成 v2 fetch 响应
 *
 * @param backend - 仓库后端
 * @param params - 解析后的 fetch 参数
 * @returns 完整的 v2 fetch 响应（pkt-line 编码）
 *
 * @example
 * ```ts
 * const params = parseFetchArgs(["want <oid>", "done"]);
 * const response = generateFetchResponse(backend, params);
 * ```
 */
export function generateFetchResponse(
  backend: RepositoryBackend,
  params: FetchServerParams,
): Buffer {
  if (params.wants.length === 0 && params.wantRefs.length === 0) {
    throw new V2ServeError("fetch: no wants or want-refs specified");
  }

  // 校验 want 对象存在性
  for (const want of params.wants) {
    if (!backend.objects.exists(want)) {
      // 用 side-band channel 3 返回错误（packfile 节为响应的最后一节，前面无 delim）
      const parts: Buffer[] = [];
      parts.push(encodePktLine("packfile\n"));
      parts.push(
        encodePktLine(
          Buffer.concat([Buffer.from([CHANNEL_FATAL]), Buffer.from(`want ${want} not found\n`)]),
        ),
      );
      parts.push(encodeFlushPkt());
      return Buffer.concat(parts);
    }
  }

  // 处理 want-ref：将 ref 名称解析为哈希后追加到 wants，并记录 refname→oid 映射
  // 以便在 packfile 前回送 wanted-refs 节（git 通过 want-ref 克隆时必需）。
  const effectiveWants = [...params.wants];
  const wantedRefs: Array<{ refname: string; oid: SHA1 }> = [];
  for (const ref of params.wantRefs) {
    const hash = resolveRefHash(backend.refs, ref);
    if (hash !== null) {
      effectiveWants.push(hash);
      wantedRefs.push({ refname: ref, oid: hash });
    }
  }

  const effectiveParams: FetchServerParams = { ...params, wants: effectiveWants };

  if (effectiveParams.wants.length === 0) {
    throw new V2ServeError("fetch: no wants resolved");
  }

  if (params.done) {
    // 带 done：直接发送 packfile（无 acknowledgments 节）
    return generatePackfileResponse(backend, effectiveParams, wantedRefs);
  }

  // 无 done：协商阶段
  const { section: ackSection, ready } = buildAcknowledgmentsSection(backend, effectiveParams);

  if (ready) {
    // 命中 ready：必须在同一响应中紧接 packfile（git 要求 "expected packfile after 'ready'"）
    return generatePackfileResponse(backend, effectiveParams, wantedRefs, ackSection);
  }

  // 未 ready：仅返回 acknowledgments 节（客户端将继续多轮协商）
  return Buffer.concat([ackSection, encodeFlushPkt()]);
}
