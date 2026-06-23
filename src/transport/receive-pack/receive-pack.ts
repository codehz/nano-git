/**
 * Git Wire 协议 v1 receive-pack 服务端实现
 *
 * 为裸仓库提供 Push 服务端能力，处理 git-receive-pack 的：
 * - Ref 广告生成（GET /info/refs?service=git-receive-pack）
 * - Push 请求处理（POST /git-receive-pack）
 *
 * 协议流程：
 * 1. 客户端 GET /info/refs?service=git-receive-pack
 * 2. 服务端返回 v1 风格 ref 广告（含 capabilities）
 * 3. 客户端 POST /git-receive-pack（ref 命令 + packfile）
 * 4. 服务端解包、校验、应用 ref 更新、返回 report-status
 *
 * @see https://git-scm.com/docs/git-receive-pack
 * @see https://git-scm.com/docs/pack-protocol#_git_gt_transport
 */

import { GitError } from "../../core/errors.ts";
import { hashObject } from "../../core/hash.ts";
import { sha1 } from "../../core/types.ts";
import { deserializeContent, serializeContent } from "../../objects/index.ts";
import {
  PACK_HEADER_SIZE,
  PACK_CHECKSUM_SIZE,
  OBJ_OFS_DELTA,
  OBJ_REF_DELTA,
  numberToObjectType,
} from "../../odb/pack/constants.ts";
import { applyDelta } from "../../odb/pack/delta.ts";
import { readCompressedData, parsePackHeader } from "../../odb/pack/pack-reader-utils.ts";
import { decodeObjectHeader, decodeOfsDeltaOffset } from "../../odb/pack/utils.ts";
import { resolveRefHash } from "../../refs/resolve.ts";
import { encodePktLine, encodeFlushPkt, splitPktLinesFromBuffer } from "../pkt-line.ts";

import type { SHA1, ObjectType } from "../../core/types.ts";
import type { ObjectStore } from "../../odb/types.ts";
import type { RepositoryBackend } from "../../repository/backend/types.ts";

// ============================================================================
// 常量
// ============================================================================

/** 零哈希（表示新建或删除引用） */
const ZERO_HASH = sha1("0000000000000000000000000000000000000000");

/** 服务端 agent 字符串 */
const SERVER_AGENT = "nano-git/0.1";

/** side-band 通道编号：packfile 数据 / report-status */
const CHANNEL_PACKFILE = 0x01;
/** side-band 通道编号：进度消息 */
const CHANNEL_PROGRESS = 0x02;
/** side-band 通道编号：致命错误 */
const _CHANNEL_FATAL = 0x03;

/** v1 广告中 prefix-ref 的 magic 名称 */
const CAPABILITIES_REF = "capabilities^{}";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * v1 receive-pack 服务错误
 *
 * 当请求解析、处理或响应生成过程中遇到可预见的错误时抛出。
 */
export class V1ReceivePackError extends GitError {
  constructor(message: string) {
    super(`v1 receive-pack: ${message}`);
    this.name = "V1ReceivePackError";
  }
}

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Receive-pack 命令（ref 更新）
 *
 * 表示客户端请求的一次 ref 变更。
 */
export interface V1ReceivePackCommand {
  /** 客户端声称的服务端当前哈希（新建时为 000...0） */
  readonly oldHash: SHA1;
  /** 要设置的目标哈希（删除时为 000...0） */
  readonly newHash: SHA1;
  /** 引用完整名称，如 "refs/heads/main" */
  readonly refName: string;
}

/**
 * 解析后的 receive-pack 请求
 */
export interface ParsedV1ReceivePackRequest {
  /** 客户端能力列表（首行 NUL 后的内容） */
  readonly capabilities: string[];
  /** ref 更新命令列表 */
  readonly commands: V1ReceivePackCommand[];
  /** packfile 数据（可能为空） */
  readonly packfile: Buffer;
}

/**
 * 单个 ref 更新的处理结果
 */
export interface V1RefUpdateResult {
  readonly refName: string;
  readonly success: boolean;
  readonly error?: string;
}

/**
 * receive-pack 处理选项
 */
export interface V1ReceivePackOptions {
  /**
   * 是否拒绝非 fast-forward 推送（类似 receive.denyNonFastForwards）
   * 默认 false
   */
  readonly denyNonFastForwards?: boolean;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 读取仓库中的所有引用
 */
function readAllRefs(backend: RepositoryBackend): Map<string, string> {
  const result = new Map<string, string>();

  const headContent = backend.refs.read("HEAD");
  if (headContent !== null) {
    result.set("HEAD", headContent);
  }

  const refNames = backend.refs.listAll();
  for (const ref of refNames) {
    const content = backend.refs.read(ref);
    if (content !== null) {
      result.set(ref, content);
    }
  }

  return result;
}

// ============================================================================
// v1 广告生成
// ============================================================================

/**
 * 生成 v1 receive-pack 的 ref 广告
 *
 * 格式：
 * ```
 * 001e# service=git-receive-pack\n
 * 0000
 * <length><hash> <refname>\0<capabilities>\n   ← 首行 ref 携带 capabilities
 * <length><hash> <refname>\n                    ← 后续 ref
 * ...
 * 0000
 * ```
 *
 * @param backend - 仓库后端
 * @returns 完整 advertisement（pkt-line 编码）
 *
 * @example
 * ```ts
 * const buf = serveV1Advertise(backend);
 * // Response 的 Content-Type 应为 "application/x-git-receive-pack-advertisement"
 * ```
 */
export function serveV1Advertise(backend: RepositoryBackend): Buffer {
  const parts: Buffer[] = [];

  // 1. service 声明
  parts.push(encodePktLine("# service=git-receive-pack\n"));
  // 2. flush
  parts.push(encodeFlushPkt());

  // 3. ref 列表
  const refs = readAllRefs(backend);
  const capabilities = [
    "report-status",
    "delete-refs",
    "side-band-64k",
    "ofs-delta",
    "no-progress",
    `agent=${SERVER_AGENT}`,
  ];
  const capStr = capabilities.join(" ");

  let firstRef = true;

  for (const [refName, content] of refs) {
    if (content.startsWith("ref: ")) {
      // 符号引用：解析为目标哈希
      const resolved = resolveRefHash(backend.refs, refName);
      if (resolved === null) continue;

      const line = firstRef ? `${resolved} ${refName}\0${capStr}\n` : `${resolved} ${refName}\n`;

      parts.push(encodePktLine(line));

      // v1 symref 属性
      const target = content.slice(5);
      parts.push(encodePktLine(`${resolved} ${refName} symref-target:${target}\n`));

      firstRef = false;
    } else if (/^[0-9a-f]{40}$/.test(content)) {
      const hash = sha1(content);

      const line = firstRef ? `${hash} ${refName}\0${capStr}\n` : `${hash} ${refName}\n`;

      parts.push(encodePktLine(line));

      // annotated tag 的 peeled 信息（refs/tags/ 下的 tag 对象）
      if (refName.startsWith("refs/tags/")) {
        const obj = backend.objects.tryRead(hash);
        if (obj?.type === "tag") {
          parts.push(encodePktLine(`${obj.object} ${refName}^{}\n`));
        }
      }

      firstRef = false;
    }
  }

  // 当仓库为空（无任何 ref）时，发送一个占位行来携带 capabilities
  if (firstRef) {
    parts.push(encodePktLine(`${ZERO_HASH} ${CAPABILITIES_REF}\0${capStr}\n`));
  }

  // 4. 结尾 flush
  parts.push(encodeFlushPkt());

  return Buffer.concat(parts);
}

// ============================================================================
// 请求解析
// ============================================================================

/**
 * 解析 v1 receive-pack push 请求 body
 *
 * 请求格式：
 * ```
 * <old-hash> <new-hash> <refname>\0<capabilities>\n   ← 首行
 * <old-hash> <new-hash> <refname>\n                    ← 后续行
 * ...
 * 0000                                                   ← flush
 * <packfile data>                                        ← packfile
 * ```
 *
 * @param body - 完整的请求 body
 * @returns 解析后的命令、能力与 packfile
 *
 * @example
 * ```ts
 * const { commands, capabilities, packfile } = parseV1ReceivePackRequest(body);
 * ```
 */
export function parseV1ReceivePackRequest(body: Buffer): ParsedV1ReceivePackRequest {
  const { lines, trailing } = splitPktLinesFromBuffer(body);

  const dataLines = lines.filter((l): l is { type: "data"; payload: Buffer } => l.type === "data");

  if (dataLines.length === 0) {
    throw new V1ReceivePackError("No commands in receive-pack request");
  }

  const commands: V1ReceivePackCommand[] = [];
  let capabilities: string[] = [];

  for (let i = 0; i < dataLines.length; i++) {
    const payload = dataLines[i]!.payload;
    const text = payload.toString("utf-8").replace(/\n$/, "");

    // 首行可能包含 NUL 分隔的 capabilities
    if (i === 0) {
      const nulIndex = text.indexOf("\0");
      if (nulIndex !== -1) {
        const cmdPart = text.substring(0, nulIndex);
        const capPart = text.substring(nulIndex + 1);
        capabilities = capPart.split(" ").filter(Boolean);

        const cmd = parseCommandLine(cmdPart);
        if (cmd) commands.push(cmd);
        continue;
      }
    }

    const cmd = parseCommandLine(text);
    if (cmd) commands.push(cmd);
  }

  if (commands.length === 0) {
    throw new V1ReceivePackError("No valid ref update commands");
  }

  return { capabilities, commands, packfile: trailing };
}

/**
 * 解析单行命令
 *
 * 格式：<old-hash> SP <new-hash> SP <refname>
 */
function parseCommandLine(text: string): V1ReceivePackCommand | null {
  const parts = text.split(" ");
  if (parts.length < 3) return null;

  const oldHash = parts[0]!;
  const newHash = parts[1]!;
  const refName = parts.slice(2).join(" ");

  // 校验哈希格式
  if (!/^[0-9a-f]{40}$/.test(oldHash)) return null;
  if (!/^[0-9a-f]{40}$/.test(newHash)) return null;

  return {
    oldHash: sha1(oldHash),
    newHash: sha1(newHash),
    refName,
  };
}

// ============================================================================
// Packfile 解包
// ============================================================================

/**
 * 将 push packfile 中的对象解包到对象存储中
 *
 * 处理非 delta、ofs_delta 和 ref_delta 三种对象类型。
 * 对于 ref_delta，如果 base 不在当前 packfile 中，则从已存在的存储中查找。
 *
 * @param store - 对象存储
 * @param packfile - push 请求中的 packfile 数据
 * @throws {V1ReceivePackError} 当解包失败时
 */
function unpackPackfile(store: ObjectStore, packfile: Buffer): void {
  if (packfile.length < PACK_HEADER_SIZE + PACK_CHECKSUM_SIZE) {
    throw new V1ReceivePackError("Packfile too small to contain any objects");
  }

  const objectCount = parsePackHeader(packfile);

  if (objectCount === 0) return;

  // 已解析对象缓存：offset → { type, data }（用于 ofs_delta 解析）
  const resolvedByOffset = new Map<number, { type: ObjectType; data: Buffer }>();
  // 已解析对象缓存：hash → { type, data }（用于 ref_delta 解析）
  const resolvedByHash = new Map<string, { type: ObjectType; data: Buffer }>();

  let offset = PACK_HEADER_SIZE;

  for (let i = 0; i < objectCount; i++) {
    const objOffset = offset;
    const [typeNum, , headerBytes] = decodeObjectHeader(packfile, offset);
    offset += headerBytes;

    if (typeNum === OBJ_OFS_DELTA) {
      const [negOffset, offsetBytes] = decodeOfsDeltaOffset(packfile, offset);
      offset += offsetBytes;

      // 读取压缩的 delta 数据
      const [deltaData, compressedBytes] = readCompressedData(packfile, offset);
      offset += compressedBytes;

      // 查找 base 对象
      const baseOffset = objOffset - negOffset;
      const base = resolvedByOffset.get(baseOffset);
      if (!base) {
        throw new V1ReceivePackError(`ofs_delta base not found at offset ${baseOffset}`);
      }

      // 应用 delta 生成完整内容
      const resolvedData = applyDelta(base.data, deltaData);
      const hash = hashObject(base.type, resolvedData);

      // 写入存储
      store.write(deserializeContent(base.type, resolvedData));

      resolvedByOffset.set(objOffset, { type: base.type, data: resolvedData });
      resolvedByHash.set(hash, { type: base.type, data: resolvedData });
    } else if (typeNum === OBJ_REF_DELTA) {
      const baseHash = packfile.subarray(offset, offset + 20).toString("hex");
      offset += 20;

      // 读取压缩的 delta 数据
      const [deltaData, compressedBytes] = readCompressedData(packfile, offset);
      offset += compressedBytes;

      // 查找 base：先在已解析缓存中查找，再在已有存储中查找
      let base: { type: ObjectType; data: Buffer } | undefined;
      const cachedBase = resolvedByHash.get(baseHash);

      if (cachedBase) {
        base = cachedBase;
      } else if (store.exists(sha1(baseHash))) {
        // 从已有存储中读取并序列化为原始内容（用于 delta 应用）
        const obj = store.read(sha1(baseHash));
        base = {
          type: obj.type,
          data: serializeContent(obj),
        };
      }

      if (!base) {
        throw new V1ReceivePackError(`ref_delta base not found: ${baseHash}`);
      }

      // 应用 delta
      const resolvedData = applyDelta(base.data, deltaData);
      const resolvedHash = hashObject(base.type, resolvedData);

      // 写入存储
      store.write(deserializeContent(base.type, resolvedData));

      resolvedByOffset.set(objOffset, { type: base.type, data: resolvedData });
      resolvedByHash.set(resolvedHash, { type: base.type, data: resolvedData });
    } else {
      // 非 delta 对象
      const [compressedData, compressedBytes] = readCompressedData(packfile, offset);
      offset += compressedBytes;

      const type = numberToObjectType(typeNum);
      const hash = hashObject(type, compressedData);

      // 写入存储
      store.write(deserializeContent(type, compressedData));

      resolvedByOffset.set(objOffset, { type, data: compressedData });
      resolvedByHash.set(hash, { type, data: compressedData });
    }
  }
}

// ============================================================================
// Ref 更新校验
// ============================================================================

/**
 * 校验单个 ref 更新命令的合法性
 *
 * 检查：
 * - oldHash 必须匹配 ref 当前值（新建时可为 000...0）
 * - newHash 对象必须存在
 * - 标签不可覆盖（允许 force — 但 v1 协议中 force 不在命令中体现）
 * - 删除操作需要 delete-refs 能力
 */
function checkRefUpdate(
  backend: RepositoryBackend,
  cmd: V1ReceivePackCommand,
  _capabilities: string[],
  _options?: V1ReceivePackOptions,
): { ok: boolean; error?: string } {
  const { oldHash, newHash, refName } = cmd;
  const isDelete = newHash === ZERO_HASH;
  const isCreate = oldHash === ZERO_HASH;

  // 读取当前 ref 值
  const currentHash = resolveRefHash(backend.refs, refName);

  // --- 新建 ref ---
  if (isCreate) {
    if (currentHash !== null) {
      return { ok: false, error: `ref ${refName} already exists` };
    }
    if (!backend.objects.exists(newHash)) {
      return { ok: false, error: `object ${newHash} not found` };
    }
    return { ok: true };
  }

  // --- 检查 ref 存在性 ---
  if (currentHash === null) {
    return {
      ok: false,
      error: `ref ${refName} does not exist (expected ${oldHash})`,
    };
  }

  // --- oldHash 必须匹配当前值 ---
  if (currentHash !== oldHash) {
    return {
      ok: false,
      error: `ref ${refName} is at ${currentHash} but expected ${oldHash}`,
    };
  }

  // --- 删除 ref ---
  if (isDelete) {
    return { ok: true };
  }

  // --- 更新 ref ---
  if (!backend.objects.exists(newHash)) {
    return { ok: false, error: `object ${newHash} not found` };
  }

  // 标签保护规则：不允许覆盖已有标签
  if (refName.startsWith("refs/tags/")) {
    return {
      ok: false,
      error: `tag ${refName} already exists and cannot be overwritten without force`,
    };
  }

  return { ok: true };
}

// ============================================================================
// Report-status 响应生成
// ============================================================================

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
function generateV1ReportStatus(
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

/**
 * 编码 side-band 帧
 */
function encodeSideBandFrame(channel: number, data: Buffer): Buffer {
  const frame = Buffer.alloc(1 + data.length);
  frame[0] = channel;
  data.copy(frame, 1);
  return encodePktLine(frame);
}

// ============================================================================
// 应用 Ref 更新
// ============================================================================

/**
 * 在事务中应用批量 ref 更新
 */
function applyRefUpdates(
  backend: RepositoryBackend,
  commands: Array<{ refName: string; newHash: SHA1 }>,
): void {
  const hooks = backend.refTransactionHooks;
  const tx = backend.refs.beginTransaction(hooks);

  try {
    for (const cmd of commands) {
      if (cmd.newHash === ZERO_HASH) {
        tx.delete(cmd.refName);
      } else {
        tx.write(cmd.refName, cmd.newHash);
      }
    }
    tx.commit();
  } catch (err) {
    tx.rollback();
    throw err;
  }
}

// ============================================================================
// 主处理函数
// ============================================================================

/**
 * 处理 receive-pack push 请求
 *
 * 完整流程：
 * 1. 验证请求体非空
 * 2. 解析客户端命令
 * 3. 检查 delete-refs 能力（如需要删除）
 * 4. 解包 packfile（如有）
 * 5. 检查组删除 / 更新 / 创建条件
 * 6. 批量应用 ref 更新
 * 7. 返回 report-status
 *
 * @param backend - 仓库后端
 * @param body - 完整的请求体
 * @param options - 处理选项
 * @returns report-status 响应（Buffer）
 *
 * @example
 * ```ts
 * const response = handleV1ReceivePush(backend, requestBody);
 * // Response 的 Content-Type 应为 "application/x-git-receive-pack-result"
 * ```
 */
export function handleV1ReceivePush(
  backend: RepositoryBackend,
  body: Buffer,
  options?: V1ReceivePackOptions,
): Buffer {
  // 1. 解析请求
  let parsed: ParsedV1ReceivePackRequest;
  try {
    parsed = parseV1ReceivePackRequest(body);
  } catch (err) {
    if (err instanceof V1ReceivePackError) throw err;
    throw new V1ReceivePackError(
      `Failed to parse receive-pack request: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { capabilities, commands, packfile } = parsed;
  const hasReportStatus = capabilities.includes("report-status");

  const hasSideBand = capabilities.includes("side-band-64k");

  // 解包 packfile（如果有）
  let unpackOk = true;
  let unpackError: string | undefined;

  if (packfile.length > 0) {
    try {
      unpackPackfile(backend.objects, packfile);
    } catch (err: unknown) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  // 校验并应用 ref 更新
  const successfulUpdates: Array<{ refName: string; newHash: SHA1 }> = [];
  const refResults: V1RefUpdateResult[] = [];

  if (unpackOk) {
    for (const cmd of commands) {
      const check = checkRefUpdate(backend, cmd, capabilities, options);

      if (check.ok) {
        successfulUpdates.push({ refName: cmd.refName, newHash: cmd.newHash });
        refResults.push({ refName: cmd.refName, success: true });
      } else {
        refResults.push({ refName: cmd.refName, success: false, error: check.error });
      }
    }

    // 事务性应用成功的更新
    if (successfulUpdates.length > 0) {
      try {
        applyRefUpdates(backend, successfulUpdates);
      } catch (err) {
        // 事务失败，将所有已成功的标记为失败
        for (const up of successfulUpdates) {
          const idx = refResults.findIndex((r) => r.refName === up.refName);
          if (idx !== -1) {
            refResults[idx] = {
              refName: up.refName,
              success: false,
              error: `transaction failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
      }
    }
  } else {
    // 解包失败，所有命令都标记为失败
    for (const cmd of commands) {
      refResults.push({
        refName: cmd.refName,
        success: false,
        error: "unpack error",
      });
    }
  }

  // 如果客户端没有请求 report-status，返回空响应
  if (!hasReportStatus) {
    return encodeFlushPkt();
  }

  return generateV1ReportStatus(unpackOk, unpackError, refResults, hasSideBand);
}
