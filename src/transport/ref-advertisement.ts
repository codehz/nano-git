/**
 * 引用广告解析
 *
 * 将服务端通过 pkt-line 编码的 ref advertisement 数据解析为
 * 结构化的 RefAdvertisement 对象。
 *
 * 数据流格式：
 *   # service=git-upload-pack\n
 *   0000                                  (flush)
 *   <hash> <refname>\0<capabilities>\n    (第一行，capabilities 紧跟在 NUL 后)
 *   <hash> <refname>\n                    (后续引用行)
 *   <hash> <refname>^{}\n                 (peeled tag)
 *   0000                                  (flush 结束)
 *
 * @see https://git-scm.com/docs/pack-protocol#_reference_discovery
 */

import { sha1, type SHA1 } from "../core/types.ts";
import { parsePktLines, PktLineError } from "./pkt-line.ts";

import type { PktLineData } from "./pkt-line.ts";
import type { RemoteRef, RefAdvertisement } from "./types.ts";

/** 服务端能力声明键值对 */
type Capabilities = Record<string, string | true>;

// ============================================================================
// 错误类型
// ============================================================================

/**
 * Ref 广告解析错误
 *
 * 当 ref advertisement 数据格式不符合 Git 协议规范时抛出。
 */
export class RefAdvertisementError extends PktLineError {
  constructor(message: string) {
    super(`ref-advertisement: ${message}`);
    this.name = "RefAdvertisementError";
  }
}

// ============================================================================
// 常量
// ============================================================================

/** 服务端头信息前缀 */
const SERVICE_HEADER_PREFIX = "# service=";

/** Peeled tag 后缀 */
const PEELED_TAG_SUFFIX = "^{}";

// ============================================================================
// 解析函数
// ============================================================================

/**
 * 解析 ref advertisement 数据
 *
 * @param data - 来自服务端的完整 ref advertisement 响应体（pkt-line 编码）
 * @param service - 服务名称（如 "git-upload-pack"）
 * @returns 结构化的 RefAdvertisement
 *
 * @example
 * ```ts
 * const data = await fetch("https://example.com/repo/info/refs?service=git-upload-pack")
 *   .then(r => r.body);
 * const adv = parseRefAdvertisement(data, "git-upload-pack");
 * console.log(adv.refs[0].name); // "refs/heads/main"
 * ```
 */
export function parseRefAdvertisement(
  data: Buffer,
  _service: "git-upload-pack" | "git-receive-pack",
): RefAdvertisement {
  const pktLines = parsePktLines(data);

  if (pktLines.length === 0) {
    throw new RefAdvertisementError("Empty ref advertisement");
  }

  let idx = 0;

  // 1. 检查并跳过服务头信息
  if (pktLines[idx]!.type === "data") {
    const firstPayload = (pktLines[idx] as PktLineData).payload.toString("utf-8");
    if (firstPayload.startsWith(SERVICE_HEADER_PREFIX)) {
      idx++; // 跳过服务头
      // 服务头后应跟一个 flush-pkt
      if (idx < pktLines.length && pktLines[idx]!.type === "flush") {
        idx++; // 跳过 flush
      }
    }
  }

  // 2. 解析 refs
  const refs: RemoteRef[] = [];
  let capabilities: Capabilities = {};

  for (; idx < pktLines.length; idx++) {
    const line = pktLines[idx]!;

    if (line.type !== "data") {
      // flush/delimiter/response-end 终止解析
      break;
    }

    const payload = line.payload;
    // NUL 截断：capabilities 在 NUL 之后
    const nullIndex = payload.indexOf(0);
    const refLine: string = (
      nullIndex === -1
        ? payload.toString("utf-8")
        : payload.subarray(0, nullIndex).toString("utf-8")
    ).trim();

    // 跳过空行
    if (refLine.length === 0) {
      continue;
    }

    // 解析 capabilities（仅第一条 ref 行包含）
    if (nullIndex !== -1 && payload.length > nullIndex + 1) {
      const capsStr = payload.subarray(nullIndex + 1).toString("utf-8");
      capabilities = parseCapabilities(capsStr);
    }

    // 如果是 peel tag 行 "hash ref^{}"
    if (refLine.endsWith(PEELED_TAG_SUFFIX)) {
      const peeledHash = parseHashFromRefLine(refLine);
      const tagName = refLine
        .slice(0, -PEELED_TAG_SUFFIX.length)
        .split(" ")
        .slice(1)
        .join(" ")
        .trim();

      // Git 空仓库以 capabilities^{} 伪 ref 承载 capabilities，跳过即可
      if (tagName === "capabilities") {
        continue;
      }

      if (refs.length === 0) {
        throw new RefAdvertisementError(`Orphaned peeled tag line "${refLine}": no preceding ref`);
      }

      const lastRef = refs[refs.length - 1]!;
      if (lastRef.name !== tagName) {
        throw new RefAdvertisementError(
          `Peeled tag name "${tagName}" does not match previous ref "${lastRef.name}"`,
        );
      }

      if (!lastRef.name.startsWith("refs/tags/")) {
        throw new RefAdvertisementError(
          `Peeled tag line "${refLine}" follows non-tag ref "${lastRef.name}"`,
        );
      }

      lastRef.peeled = peeledHash;
      continue;
    }

    // 普通 ref 行 "hash name"
    const ref = parseRefLine(refLine);
    refs.push(ref);
  }

  return { capabilities, refs };
}

// ============================================================================
// 内部辅助函数
// ============================================================================

/**
 * 从 ref 行中提取 hash
 *
 * @param line - 类似 "95d09f2b... refs/tags/v1.0^{}" 的行
 * @returns SHA1 哈希
 */
function parseHashFromRefLine(line: string): SHA1 {
  const hashStr = line.split(" ")[0];
  if (!hashStr) {
    throw new RefAdvertisementError(`Cannot parse hash from ref line: "${line}"`);
  }
  return sha1(hashStr);
}

/**
 * 解析单条 ref 行
 *
 * @param line - 类似 "95d09f2b... refs/heads/main" 的行
 * @returns RemoteRef 对象
 */
function parseRefLine(line: string): RemoteRef {
  const spaceIndex = line.indexOf(" ");
  if (spaceIndex === -1) {
    throw new RefAdvertisementError(`Invalid ref line: "${line}"`);
  }

  const hashStr = line.substring(0, spaceIndex);
  const name = line.substring(spaceIndex + 1).trim();

  if (hashStr.length !== 40) {
    throw new RefAdvertisementError(`Invalid hash in ref line: "${line}"`);
  }

  return {
    hash: sha1(hashStr),
    name,
  };
}

/**
 * 解析 capabilities 字符串
 *
 * capabilities 以空格分隔，可能带参数（key=value）或不带参数（key）
 *
 * @param capsStr - 如 "multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed symref=HEAD:refs/heads/main agent=git/2.45.1"
 * @returns 解析后的 capabilities 对象
 */
function parseCapabilities(capsStr: string): Capabilities {
  const caps: Capabilities = {};
  const tokens = capsStr.split(" ");

  for (const token of tokens) {
    if (token.length === 0) continue;

    const eqIndex = token.indexOf("=");
    if (eqIndex === -1) {
      caps[token] = true;
    } else {
      const key = token.substring(0, eqIndex);
      const value = token.substring(eqIndex + 1);
      caps[key] = value;
    }
  }

  return caps;
}
