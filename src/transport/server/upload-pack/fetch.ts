/**
 * v2 fetch 命令响应生成
 *
 * 处理 fetch 命令，计算对象集合、构建 packfile、生成 fetch 响应。
 *
 * @see https://git-scm.com/docs/protocol-v2#_fetch
 */

import { allocBytes, concatBytes, copyBytes, utf8ToBytes } from "../../../bytes.ts";
import { tryReadObject } from "../../../objects/raw.ts";
import { createPackWriter } from "../../../pack/writer/pack-writer.ts";
import { resolveRefHash } from "../../../refs/resolve.ts";
import { sha1 } from "../../../types/index.ts";
import { TAGS_PREFIX } from "../../../types/refs.ts";
import { collectReachable, isAncestor, peelTagChain } from "../../protocol/object-graph.ts";
import { encodePktLine, encodeFlushPkt, encodeDelimiterPkt } from "../../protocol/pkt-line.ts";
import {
  CHANNEL_PACKFILE,
  CHANNEL_FATAL,
  MAX_PKT_PAYLOAD,
  UploadPackServiceError,
} from "./types.ts";

import type { RepositoryBackend } from "../../../backend/types.ts";
import type { SHA1 } from "../../../types/index.ts";

/** 从 fetch 请求 args 中解析的参数 */
export interface FetchServerParams {
  readonly wants: SHA1[];
  readonly haves: SHA1[];
  readonly shallow: SHA1[];
  readonly wantRefs: string[];
  readonly done: boolean;
  readonly sidebandAll?: boolean;
  readonly waitForDone?: boolean;
  readonly thinPack: boolean;
  readonly noProgress: boolean;
  readonly ofsDelta: boolean;
  readonly includeTag?: boolean;
  readonly deepen?: number;
  readonly deepenRelative?: boolean;
  readonly deepenSince?: number;
  readonly deepenNot: string[];
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
  const shallow: SHA1[] = [];
  const wantRefs: string[] = [];
  let done = false;
  let sidebandAll = false;
  let waitForDone = false;
  let thinPack = false;
  let noProgress = false;
  let ofsDelta = false;
  let includeTag = false;
  let deepen: number | undefined;
  let deepenRelative = false;
  let deepenSince: number | undefined;
  const deepenNot: string[] = [];

  for (const arg of args) {
    if (arg === "done") {
      done = true;
    } else if (arg === "sideband-all") {
      sidebandAll = true;
    } else if (arg === "wait-for-done") {
      waitForDone = true;
    } else if (arg === "thin-pack") {
      thinPack = true;
    } else if (arg === "no-progress") {
      noProgress = true;
    } else if (arg === "ofs-delta") {
      ofsDelta = true;
    } else if (arg === "include-tag") {
      includeTag = true;
    } else if (arg === "deepen-relative") {
      deepenRelative = true;
    } else if (arg.startsWith("shallow ")) {
      shallow.push(sha1(arg.slice(8).trim()));
    } else if (arg.startsWith("deepen ")) {
      deepen = Number.parseInt(arg.slice(7).trim(), 10);
    } else if (arg.startsWith("deepen-since ")) {
      deepenSince = Number.parseInt(arg.slice(13).trim(), 10);
    } else if (arg.startsWith("deepen-not ")) {
      deepenNot.push(arg.slice(11).trim());
    } else if (arg.startsWith("want ")) {
      wants.push(sha1(arg.slice(5).trim()));
    } else if (arg.startsWith("have ")) {
      haves.push(sha1(arg.slice(5).trim()));
    } else if (arg.startsWith("want-ref ")) {
      wantRefs.push(arg.slice(9).trim());
    }
  }

  return {
    wants,
    haves,
    shallow,
    wantRefs,
    done,
    sidebandAll,
    waitForDone,
    thinPack,
    noProgress,
    ofsDelta,
    includeTag,
    deepen,
    deepenRelative,
    deepenSince,
    deepenNot,
  };
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
interface ShallowFetchPlan {
  readonly clientShallow: ReadonlySet<SHA1>;
  readonly serverShallow?: ReadonlySet<SHA1>;
  readonly sourceShallowResponse?: readonly SHA1[];
  readonly shallowUpdate?: {
    readonly shallow: SHA1[];
    readonly unshallow: SHA1[];
  };
}

interface SourceReachableShallowInfo {
  readonly boundarySet: ReadonlySet<SHA1>;
  readonly responseLines: readonly SHA1[];
}

function resolveSourceReachableShallowBoundaries(
  backend: RepositoryBackend,
  wants: readonly SHA1[],
): SourceReachableShallowInfo | undefined {
  const storedShallow = backend.shallow.read();
  if (storedShallow.length === 0) {
    return undefined;
  }

  const storedSet = new Set<SHA1>(storedShallow);
  const responseLines: SHA1[] = [];
  const boundarySet = new Set<SHA1>();
  const wantRoots = [...new Set(wants.map((hash) => peelTagChain(backend.objects, hash)))];

  for (const root of wantRoots) {
    const queue = [root];
    const visited = new Set<SHA1>();
    const seenForWant = new Set<SHA1>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);

      if (storedSet.has(current)) {
        boundarySet.add(current);
        if (!seenForWant.has(current)) {
          responseLines.push(current);
          seenForWant.add(current);
        }
        continue;
      }

      const obj = tryReadObject(backend.objects, current);
      if (!obj) {
        continue;
      }

      if (obj.type === "tag") {
        queue.push(obj.object);
        continue;
      }

      if (obj.type === "commit") {
        for (const parent of obj.parents) {
          queue.push(parent);
        }
      }
    }
  }

  return boundarySet.size > 0 ? { boundarySet, responseLines } : undefined;
}

function resolveExcludedReachable(
  backend: RepositoryBackend,
  deepenNot: readonly string[],
  shallowBoundaries?: ReadonlySet<SHA1>,
): ReadonlySet<SHA1> | undefined {
  if (deepenNot.length === 0) {
    return undefined;
  }

  const excludeRoots: SHA1[] = [];
  for (const refName of deepenNot) {
    const hash = resolveDeepenNotTargetHash(backend, refName);
    if (hash === null) {
      throw new UploadPackServiceError(`fetch: deepen-not is not a ref: ${refName}`);
    }
    excludeRoots.push(hash);
  }

  if (excludeRoots.length === 0) {
    return undefined;
  }

  return collectReachable(
    backend.objects,
    excludeRoots,
    "skip-commit-parents",
    shallowBoundaries ? new Set(shallowBoundaries) : undefined,
  );
}

function resolveDeepenNotTargetHash(backend: RepositoryBackend, rev: string): SHA1 | null {
  const tryResolveRef = (refName: string): SHA1 | null => {
    const hash = resolveRefHash(backend.refs, refName);
    return hash === null ? null : peelTagChain(backend.objects, hash);
  };

  if (rev === "HEAD" || rev.startsWith("refs/")) {
    return tryResolveRef(rev);
  }

  return (
    tryResolveRef(`refs/heads/${rev}`) ??
    tryResolveRef(`refs/tags/${rev}`) ??
    tryResolveRef(`refs/remotes/${rev}`)
  );
}

interface DepthLimitedShallowState {
  readonly boundary: Set<SHA1>;
  readonly visited: Set<SHA1>;
  readonly selectedCommitCount: number;
}

function computeDepthLimitedShallowState(
  backend: RepositoryBackend,
  wants: readonly SHA1[],
  maxDepth: number,
  deepenSince: number | undefined,
  excludedReachable: ReadonlySet<SHA1> | undefined,
): DepthLimitedShallowState {
  const boundary = new Set<SHA1>();
  const visited = new Set<SHA1>();
  const queue = wants.map((hash) => ({ hash: peelTagChain(backend.objects, hash), depth: 1 }));
  const visitedDepth = new Map<SHA1, number>();
  let selectedCommitCount = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const previousDepth = visitedDepth.get(current.hash);
    if (previousDepth !== undefined && previousDepth <= current.depth) {
      continue;
    }
    visitedDepth.set(current.hash, current.depth);

    const obj = tryReadObject(backend.objects, current.hash);
    if (!obj || obj.type !== "commit") {
      visited.add(current.hash);
      continue;
    }

    if (deepenSince !== undefined && obj.committer.timestamp < deepenSince) {
      continue;
    }

    selectedCommitCount++;
    visited.add(current.hash);

    let omittedParent = false;
    for (const parent of obj.parents) {
      if (excludedReachable?.has(parent)) {
        omittedParent = true;
        continue;
      }

      const parentObj = tryReadObject(backend.objects, parent);
      if (parentObj?.type === "commit" && deepenSince !== undefined) {
        if (parentObj.committer.timestamp < deepenSince) {
          omittedParent = true;
          continue;
        }
      }

      if (current.depth >= maxDepth) {
        omittedParent = true;
        continue;
      }

      queue.push({ hash: parent, depth: current.depth + 1 });
    }

    if (omittedParent) {
      boundary.add(current.hash);
    }
  }

  return { boundary, visited, selectedCommitCount };
}

function computeRelativeDeepenBoundary(
  backend: RepositoryBackend,
  currentShallow: readonly SHA1[],
  deepen: number,
): Set<SHA1> {
  const boundary = new Set<SHA1>();
  const queue = currentShallow.map((hash) => ({ hash, depth: 0 }));
  const visited = new Map<SHA1, number>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const previousDepth = visited.get(current.hash);
    if (previousDepth !== undefined && previousDepth <= current.depth) {
      continue;
    }
    visited.set(current.hash, current.depth);

    const obj = tryReadObject(backend.objects, current.hash);
    if (!obj || obj.type !== "commit") {
      continue;
    }

    if (current.depth >= deepen) {
      boundary.add(current.hash);
      continue;
    }

    for (const parent of obj.parents) {
      queue.push({ hash: parent, depth: current.depth + 1 });
    }
  }

  return boundary;
}

function createShallowFetchPlan(
  backend: RepositoryBackend,
  params: FetchServerParams,
): ShallowFetchPlan {
  const clientShallow = new Set<SHA1>(params.shallow);
  const sourceShallowInfo = resolveSourceReachableShallowBoundaries(backend, params.wants);
  const sourceShallow = sourceShallowInfo?.boundarySet;
  const excludedReachable = resolveExcludedReachable(backend, params.deepenNot, sourceShallow);
  let serverShallow = sourceShallow ? new Set(sourceShallow) : undefined;
  let sourceShallowResponse = sourceShallowInfo?.responseLines;

  if (excludedReachable) {
    for (const want of params.wants) {
      if (excludedReachable.has(want)) {
        throw new UploadPackServiceError(`fetch: want ${want} is excluded by deepen-not`);
      }
    }
  }

  if (params.deepenRelative && params.deepen !== undefined) {
    const relativeBoundary = computeRelativeDeepenBoundary(backend, params.shallow, params.deepen);
    if (serverShallow) {
      for (const hash of relativeBoundary) {
        serverShallow.add(hash);
      }
    } else {
      serverShallow = relativeBoundary;
    }
  } else if (
    params.deepen !== undefined ||
    params.deepenSince !== undefined ||
    params.deepenNot.length > 0
  ) {
    const maxDepth = params.deepen ?? Number.MAX_SAFE_INTEGER;
    const depthLimitedState = computeDepthLimitedShallowState(
      backend,
      params.wants,
      maxDepth,
      params.deepenSince,
      excludedReachable,
    );
    if (params.deepenSince !== undefined && depthLimitedState.selectedCommitCount === 0) {
      throw new UploadPackServiceError("fetch: no commits selected for shallow requests");
    }
    if (params.deepenSince !== undefined && sourceShallow) {
      for (const hash of sourceShallow) {
        if (depthLimitedState.visited.has(hash)) {
          throw new UploadPackServiceError(
            "fetch: deepen-since cannot traverse source shallow boundary",
          );
        }
      }
    }
    serverShallow = new Set<SHA1>();
    sourceShallowResponse = undefined;
    for (const hash of depthLimitedState.boundary) {
      serverShallow.add(hash);
    }
    for (const hash of clientShallow) {
      if (!depthLimitedState.visited.has(hash) || depthLimitedState.boundary.has(hash)) {
        serverShallow.add(hash);
      }
    }
  }

  if (!serverShallow) {
    return { clientShallow };
  }

  const shallow: SHA1[] = [];
  if (sourceShallowResponse) {
    for (const hash of sourceShallowResponse) {
      if (!clientShallow.has(hash)) {
        shallow.push(hash);
      }
    }
  }
  for (const hash of serverShallow) {
    if (!clientShallow.has(hash) && !sourceShallow?.has(hash)) {
      shallow.push(hash);
    }
  }
  const unshallow = [...clientShallow].filter((hash) => !serverShallow.has(hash));

  return {
    clientShallow,
    serverShallow,
    sourceShallowResponse,
    shallowUpdate: shallow.length > 0 || unshallow.length > 0 ? { shallow, unshallow } : undefined,
  };
}

function addAnnotatedTagsToPack(
  backend: RepositoryBackend,
  objectsToPack: ReadonlySet<SHA1>,
): Set<SHA1> {
  const withTags = new Set(objectsToPack);
  let changed = true;

  while (changed) {
    changed = false;

    for (const refName of backend.refs.list(TAGS_PREFIX)) {
      const hash = resolveRefHash(backend.refs, refName);
      if (hash === null || withTags.has(hash)) {
        continue;
      }

      const obj = tryReadObject(backend.objects, hash);
      if (obj?.type !== "tag") {
        continue;
      }

      if (withTags.has(obj.object)) {
        withTags.add(hash);
        changed = true;
      }
    }
  }

  return withTags;
}

function computeObjectsToPack(
  backend: RepositoryBackend,
  params: FetchServerParams,
  shallowPlan: ShallowFetchPlan,
): Set<SHA1> {
  const finalizeObjectsToPack = (objectsToPack: Set<SHA1>): Set<SHA1> =>
    params.includeTag ? addAnnotatedTagsToPack(backend, objectsToPack) : objectsToPack;

  if (params.haves.length === 0) {
    return finalizeObjectsToPack(
      collectReachable(
        backend.objects,
        params.wants,
        "skip-commit-parents",
        shallowPlan.serverShallow ? new Set(shallowPlan.serverShallow) : undefined,
      ),
    );
  }

  // 增量 fetch：A - B
  const wantReachable = collectReachable(
    backend.objects,
    params.wants,
    "skip-commit-parents",
    shallowPlan.serverShallow ? new Set(shallowPlan.serverShallow) : undefined,
  );
  const haveReachable = collectReachable(
    backend.objects,
    params.haves,
    "skip-commit-parents",
    shallowPlan.clientShallow.size > 0 ? new Set(shallowPlan.clientShallow) : undefined,
  );

  const result = new Set<SHA1>();
  for (const hash of wantReachable) {
    if (!haveReachable.has(hash)) {
      result.add(hash);
    }
  }
  return finalizeObjectsToPack(result);
}

// ============================================================================
// side-band 编码
// ============================================================================

/**
 * 将 packfile 数据以 side-band channel 1 格式分帧
 *
 * 每个 pkt-line 帧：<4字节长度><1字节channel><数据>
 */
function encodePackfileWithSideBand(packfile: Uint8Array): Uint8Array[] {
  const maxPayload = MAX_PKT_PAYLOAD - 1; // 1 byte for channel
  const frames: Uint8Array[] = [];
  let offset = 0;

  while (offset < packfile.length) {
    const chunkSize = Math.min(maxPayload, packfile.length - offset);
    const frame = allocBytes(1 + chunkSize);
    frame[0] = CHANNEL_PACKFILE;
    copyBytes(frame, 1, packfile, offset, chunkSize);
    frames.push(encodePktLine(frame));
    offset += chunkSize;
  }

  return frames;
}

function encodeSidebandData(payload: string | Uint8Array, channel = CHANNEL_PACKFILE): Uint8Array {
  const data = typeof payload === "string" ? utf8ToBytes(payload) : payload;
  return encodePktLine(concatBytes(Uint8Array.from([channel]), data));
}

function shouldEmitShallowInfoSection(
  params: FetchServerParams,
  shallowPlan: ShallowFetchPlan,
): boolean {
  return (
    shallowPlan.shallowUpdate !== undefined ||
    params.shallow.length > 0 ||
    params.deepen !== undefined ||
    params.deepenRelative === true ||
    params.deepenSince !== undefined ||
    params.deepenNot.length > 0
  );
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
  shallowPlan: ShallowFetchPlan,
  ackSection?: Uint8Array,
): Uint8Array {
  const parts: Uint8Array[] = [];

  // acknowledgments 节（仅协商命中 ready 时）：与后续节之间以 delim-pkt 分隔。
  if (ackSection !== undefined) {
    parts.push(ackSection);
    parts.push(encodeDelimiterPkt());
  }

  if (shouldEmitShallowInfoSection(params, shallowPlan)) {
    parts.push(
      params.sidebandAll ? encodeSidebandData("shallow-info\n") : encodePktLine("shallow-info\n"),
    );
    for (const hash of shallowPlan.shallowUpdate?.shallow ?? []) {
      parts.push(
        params.sidebandAll
          ? encodeSidebandData(`shallow ${hash}\n`)
          : encodePktLine(`shallow ${hash}\n`),
      );
    }
    for (const hash of shallowPlan.shallowUpdate?.unshallow ?? []) {
      parts.push(
        params.sidebandAll
          ? encodeSidebandData(`unshallow ${hash}\n`)
          : encodePktLine(`unshallow ${hash}\n`),
      );
    }
    parts.push(encodeDelimiterPkt());
  }

  // wanted-refs 节：当客户端通过 want-ref 请求时必须回送 refname→oid 映射，
  // 否则 git 无法得知每个 ref 解析到的对象。该节后接 delim-pkt 与 packfile 节分隔。
  if (wantedRefs.length > 0) {
    parts.push(
      params.sidebandAll ? encodeSidebandData("wanted-refs\n") : encodePktLine("wanted-refs\n"),
    );
    for (const { refname, oid } of wantedRefs) {
      parts.push(
        params.sidebandAll
          ? encodeSidebandData(`${oid} ${refname}\n`)
          : encodePktLine(`${oid} ${refname}\n`),
      );
    }
    parts.push(encodeDelimiterPkt());
  }

  // 计算要发送的对象集合
  const toPack = computeObjectsToPack(backend, params, shallowPlan);

  // 构建 packfile
  const writer = createPackWriter();
  for (const hash of toPack) {
    const raw = backend.objects.tryRead(hash);
    if (raw) {
      writer.addRaw(raw);
    }
  }

  const packfile = writer.build();

  // packfile 节
  parts.push(params.sidebandAll ? encodeSidebandData("packfile\n") : encodePktLine("packfile\n"));

  // side-band 编码的 packfile 数据
  if (packfile.length > 0) {
    parts.push(...encodePackfileWithSideBand(packfile));
  }

  parts.push(encodeFlushPkt());

  return concatBytes(...parts);
}

/**
 * 查找 wants 与 haves 间的共同对象
 *
 * ACK 的判定仍以“客户端声明 have，且服务端本地确实存在该对象”为准；
 * 但 `ready` 不能仅凭“存在任意 common”就成立，而要确认每个 want
 * 都已经能沿 tag/commit 链回溯到某个 common cut-point。
 */
function findCommonObjects(
  backend: RepositoryBackend,
  wants: SHA1[],
  haves: SHA1[],
): { common: SHA1[]; acks: SHA1[]; ready: boolean } {
  const common: SHA1[] = [];

  for (const have of haves) {
    if (backend.objects.exists(have)) {
      common.push(have);
    }
  }

  const acks = selectAcknowledgedCommons(backend, common);
  const ready = canReadyWithCommonBase(backend, wants, common);

  return { common, acks, ready };
}

function selectAcknowledgedCommons(backend: RepositoryBackend, common: readonly SHA1[]): SHA1[] {
  const acks: SHA1[] = [];

  for (const have of common) {
    // 与 git-http-backend 的常见行为保持接近：
    // 仅跳过那些已经被更“新”的已 ACK common 覆盖的祖先 have。
    const redundant = acks.some((acked) => isAncestor(backend.objects, have, acked));
    if (!redundant) {
      acks.push(have);
    }
  }

  return acks;
}

function canReadyWithCommonBase(
  backend: RepositoryBackend,
  wants: readonly SHA1[],
  common: readonly SHA1[],
): boolean {
  if (common.length === 0) {
    return false;
  }

  const commonSet = collectCommonCutPoints(backend, common);
  for (const want of wants) {
    if (!wantReachesCommon(backend, want, commonSet)) {
      return false;
    }
  }
  return true;
}

function collectCommonCutPoints(backend: RepositoryBackend, common: readonly SHA1[]): Set<SHA1> {
  const commonSet = new Set<SHA1>();
  const queue = [...common];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (commonSet.has(current)) {
      continue;
    }
    commonSet.add(current);

    const obj = tryReadObject(backend.objects, current);
    if (!obj) {
      continue;
    }

    if (obj.type === "tag") {
      queue.push(obj.object);
      continue;
    }

    if (obj.type === "commit") {
      for (const parent of obj.parents) {
        queue.push(parent);
      }
    }
  }

  return commonSet;
}

function wantReachesCommon(
  backend: RepositoryBackend,
  want: SHA1,
  commonSet: ReadonlySet<SHA1>,
): boolean {
  const start = peelTagChain(backend.objects, want);
  const queue: SHA1[] = [start];
  const visited = new Set<SHA1>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (commonSet.has(current)) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const obj = tryReadObject(backend.objects, current);
    if (!obj) {
      continue;
    }

    if (obj.type === "tag") {
      queue.push(obj.object);
      continue;
    }

    if (obj.type === "commit") {
      for (const parent of obj.parents) {
        queue.push(parent);
      }
    }
  }

  return false;
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
): { section: Uint8Array; ready: boolean } {
  const parts: Uint8Array[] = [];
  parts.push(
    params.sidebandAll
      ? encodeSidebandData("acknowledgments\n")
      : encodePktLine("acknowledgments\n"),
  );

  const { common, acks, ready } = findCommonObjects(backend, params.wants, params.haves);

  if (common.length > 0) {
    for (const oid of acks) {
      parts.push(
        params.sidebandAll ? encodeSidebandData(`ACK ${oid}\n`) : encodePktLine(`ACK ${oid}\n`),
      );
    }
    if (ready && !params.waitForDone) {
      parts.push(params.sidebandAll ? encodeSidebandData("ready\n") : encodePktLine("ready\n"));
    }
  } else {
    parts.push(params.sidebandAll ? encodeSidebandData("NAK\n") : encodePktLine("NAK\n"));
  }

  return { section: concatBytes(...parts), ready: ready && !params.waitForDone };
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
): Uint8Array {
  if (params.wants.length === 0 && params.wantRefs.length === 0) {
    throw new UploadPackServiceError("fetch: no wants or want-refs specified");
  }

  // 校验 want 对象存在性
  for (const want of params.wants) {
    if (!backend.objects.exists(want)) {
      // 用 side-band channel 3 返回错误（packfile 节为响应的最后一节，前面无 delim）
      const parts: Uint8Array[] = [];
      parts.push(
        params.sidebandAll ? encodeSidebandData("packfile\n") : encodePktLine("packfile\n"),
      );
      parts.push(
        params.sidebandAll
          ? encodeSidebandData(`want ${want} not found\n`, CHANNEL_FATAL)
          : encodePktLine(
              concatBytes(
                Uint8Array.from([CHANNEL_FATAL]),
                utf8ToBytes(`want ${want} not found\n`),
              ),
            ),
      );
      parts.push(encodeFlushPkt());
      return concatBytes(...parts);
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
  const shallowPlan = createShallowFetchPlan(backend, effectiveParams);

  if (effectiveParams.wants.length === 0) {
    throw new UploadPackServiceError("fetch: no wants resolved");
  }

  if (params.done) {
    // 带 done：直接发送 packfile（无 acknowledgments 节）
    return generatePackfileResponse(backend, effectiveParams, wantedRefs, shallowPlan);
  }

  // 无 done：协商阶段
  const { section: ackSection, ready } = buildAcknowledgmentsSection(backend, effectiveParams);

  if (ready) {
    // 命中 ready：必须在同一响应中紧接 packfile（git 要求 "expected packfile after 'ready'"）
    return generatePackfileResponse(backend, effectiveParams, wantedRefs, shallowPlan, ackSection);
  }

  // 未 ready：仅返回 acknowledgments 节（客户端将继续多轮协商）
  return concatBytes(ackSection, encodeFlushPkt());
}
