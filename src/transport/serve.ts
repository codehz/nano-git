/**
 * Git Wire 协议 v2 服务端实现
 *
 * 提供服务端能力广告、ls-refs 和 fetch 命令的响应生成。
 * 完全独立于 HTTP 框架，只依赖 RepositoryBackend。
 *
 * 与 git-http-backend 的设计哲学一致：
 * - 纯数据进、数据出，不绑定任何 HTTP 服务器
 * - 调用方负责解析 HTTP 请求、注入 RepositoryBackend
 * - 可便捷接入 Bun.serve、Node.js http、Express 等
 *
 * @see https://git-scm.com/docs/protocol-v2
 */

import { sha1 } from "../core/types.ts";
import { createPackWriter } from "../odb/pack/pack-writer.ts";
import { resolveRefHash } from "../refs/resolve.ts";
import { collectReachable } from "./object-graph.ts";
import { encodePktLine, encodeFlushPkt, encodeDelimiterPkt, parsePktLines } from "./pkt-line.ts";

import type { SHA1 } from "../core/types.ts";
import type { RepositoryBackend } from "../repository/backend/types.ts";

// ============================================================================
// 常量
// ============================================================================

/** 服务端 agent 字符串 */
const SERVER_AGENT = "nano-git/0.1";

/** side-band 通道编号 */
const CHANNEL_PACKFILE = 0x01;
const CHANNEL_FATAL = 0x03;

/** pkt-line 单帧最大负载字节数 */
const MAX_PKT_PAYLOAD = 65520;

/**
 * 服务端错误
 *
 * 当服务端处理请求时遇到可预见的错误情况抛出。
 */
export class V2ServeError extends Error {
  constructor(message: string) {
    super(`v2 serve: ${message}`);
    this.name = "V2ServeError";
  }
}

// ============================================================================
// v2 能力广告
// ============================================================================

/**
 * 生成 v2 能力广告
 *
 * @param service - 服务类型（"git-upload-pack" 或 "git-receive-pack"）
 * @returns 完整的 pkt-line 编码能力广告
 *
 * @example
 * ```ts
 * const response = serveV2Advertise("git-upload-pack");
 * // "000eversion 2\n000bls-refs\n...0000"
 * ```
 */
export function serveV2Advertise(service: string): Buffer {
  const parts: Buffer[] = [];

  parts.push(encodePktLine("version 2\n"));

  if (service === "git-upload-pack") {
    parts.push(encodePktLine("ls-refs\n"));
    parts.push(encodePktLine("fetch=shallow ref-in-want filter\n"));
  } else {
    throw new V2ServeError(`unsupported service: ${service}`);
  }

  parts.push(encodePktLine(`agent=${SERVER_AGENT}\n`));
  parts.push(encodeFlushPkt());

  return Buffer.concat(parts);
}

// ============================================================================
// 命令解析
// ============================================================================

/**
 * 解析后的 v2 命令请求
 */
export interface ParsedV2Command {
  /** 命令名称（如 "ls-refs"、"fetch"） */
  readonly command: string;
  /** capability-list（command 行后的 pkt-line，至 delimiter 前） */
  readonly capabilities: string[];
  /** command-args（delimiter 后的 pkt-line，至 flush 前） */
  readonly args: string[];
}

/**
 * 解析 v2 命令请求体
 *
 * 请求格式：
 * ```
 * command=<name>\n
 * <capability-list>
 * 0001
 * <command-args>
 * 0000
 * ```
 *
 * @param body - 完整的请求体（pkt-line 编码）
 * @returns 解析后的命令信息
 *
 * @example
 * ```ts
 * const cmd = parseV2Command(body);
 * console.log(cmd.command); // "ls-refs"
 * ```
 */
export function parseV2Command(body: Buffer): ParsedV2Command {
  const pktLines = parsePktLines(body);
  let command = "";
  const capabilities: string[] = [];
  const args: string[] = [];
  let afterDelimiter = false;

  for (const pkt of pktLines) {
    if (pkt.type === "flush") {
      break;
    }
    if (pkt.type === "delimiter") {
      afterDelimiter = true;
      continue;
    }
    if (pkt.type !== "data") {
      continue;
    }

    const text = pkt.payload.toString("utf-8").replace(/\n$/, "");

    if (!afterDelimiter) {
      if (text.startsWith("command=")) {
        command = text.slice(8);
      } else {
        capabilities.push(text);
      }
    } else {
      args.push(text);
    }
  }

  return { command, capabilities, args };
}

// ============================================================================
// ls-refs 响应
// ============================================================================

/** ls-refs 请求中解析出的选项 */
export interface LsRefsServerOptions {
  readonly symrefs: boolean;
  readonly peel: boolean;
  readonly unborn: boolean;
  readonly refPrefixes: string[];
}

/**
 * 从 args 中解析 ls-refs 选项
 *
 * @param args - ls-refs 命令的 args 列表
 * @returns 结构化的 ls-refs 选项
 *
 * @example
 * ```ts
 * const opts = parseLsRefsArgs(["symrefs", "peel", "ref-prefix refs/heads/"]);
 * // { symrefs: true, peel: true, unborn: false, refPrefixes: ["refs/heads/"] }
 * ```
 */
export function parseLsRefsArgs(args: string[]): LsRefsServerOptions {
  const prefixes: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("ref-prefix ")) {
      prefixes.push(arg.slice(11).trim());
    }
  }

  return {
    symrefs: args.includes("symrefs"),
    peel: args.includes("peel"),
    unborn: args.includes("unborn"),
    refPrefixes: prefixes,
  };
}

/**
 * 读取仓库中的所有引用
 *
 * 包含 HEAD 和 refs/ 下的所有引用，返回名称到原始内容的映射。
 * 原始内容可能是 SHA-1 哈希或以 "ref: " 开头的符号引用。
 */
function readAllRefs(backend: RepositoryBackend): Map<string, string> {
  const result = new Map<string, string>();

  // HEAD（可能在 refs/ 外部）
  const headContent = backend.refs.read("HEAD");
  if (headContent !== null) {
    result.set("HEAD", headContent);
  }

  // refs/ 下的所有引用
  const refNames = backend.refs.listAll();
  for (const ref of refNames) {
    const content = backend.refs.read(ref);
    if (content !== null) {
      result.set(ref, content);
    }
  }

  return result;
}

/**
 * 按 ref-prefix 过滤引用
 *
 * HEAD 始终包含（因为它可能符号引用到 unborn branch）。
 */
function filterRefsByPrefix(refs: Map<string, string>, prefixes: string[]): Map<string, string> {
  if (prefixes.length === 0) {
    return refs;
  }

  const result = new Map<string, string>();
  for (const [name, content] of refs) {
    if (name === "HEAD") {
      result.set(name, content);
      continue;
    }
    for (const prefix of prefixes) {
      if (name.startsWith(prefix)) {
        result.set(name, content);
        break;
      }
    }
  }
  return result;
}

/**
 * 生成 ls-refs 响应
 *
 * @param backend - 仓库后端
 * @param options - ls-refs 选项
 * @returns pkt-line 编码的 ls-refs 响应
 *
 * @example
 * ```ts
 * const buf = generateLsRefsResponse(backend, { symrefs: true, peel: true, unborn: false, refPrefixes: [] });
 * ```
 */
export function generateLsRefsResponse(
  backend: RepositoryBackend,
  options: LsRefsServerOptions,
): Buffer {
  const rawRefs = readAllRefs(backend);
  const filtered = filterRefsByPrefix(rawRefs, options.refPrefixes);
  const lines: Buffer[] = [];

  for (const [refName, content] of filtered) {
    if (content === null || content.length === 0) continue;

    if (content.startsWith("ref: ")) {
      // 符号引用
      const target = content.slice(5);
      const resolved = resolveRefHash(backend.refs, refName);

      if (resolved === null && !options.unborn) {
        // unborn 且未请求 unborn 信息，跳过
        continue;
      }

      const oid = resolved ?? "unborn";
      const attrs: string[] = [];

      if (options.symrefs) {
        attrs.push(`symref-target:${target}`);
      }

      const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
      lines.push(encodePktLine(`${oid} ${refName}${attrStr}\n`));
    } else if (/^[0-9a-f]{40}$/.test(content)) {
      // 直接引用（SHA-1）
      const oid = sha1(content);
      const attrs: string[] = [];

      // annotated tag 且请求了 peel
      if (options.peel && refName.startsWith("refs/tags/")) {
        const obj = backend.objects.tryRead(oid);
        if (obj?.type === "tag") {
          attrs.push(`peeled:${obj.object}`);
        }
      }

      const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
      lines.push(encodePktLine(`${oid} ${refName}${attrStr}\n`));
    }
    // 其他内容格式跳过（不合法引用条目）
  }

  lines.push(encodeFlushPkt());
  return Buffer.concat(lines);
}

// ============================================================================
// fetch 响应
// ============================================================================

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
