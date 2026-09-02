/**
 * v2 能力广告解析
 *
 * 解析 Git Wire 协议 v2 的 capability advertisement 响应。
 *
 * 规范 v2 能力广告格式：
 * ```
 * 000eversion 2\n
 * ls-refs\n
 * fetch=shallow ref-in-want\n
 * push\n
 * object-info\n
 * agent=nano-git/0.1\n
 * 0000
 * ```
 *
 * Smart HTTP 下部分服务端（尤其是未协商到 v2 时的 v0 回落，或非规范实现）
 * 可能在前面附加 service 包装：
 * ```
 * 001e# service=git-upload-pack\n
 * 0000
 * 000eversion 2\n
 * ...
 * 0000
 * ```
 * 解析器会可选剥离 `# service=git-upload-pack` + flush，再要求 `version 2`。
 * 若剥离后不是 v2 能力广告，抛出明确的「未协商到 protocol v2」错误（不实现 v0 fetch）。
 *
 * @see https://git-scm.com/docs/protocol-v2#_capability_advertisement
 * @see https://git-scm.com/docs/http-protocol#_smart_server_response
 */

import { bytesToUtf8 } from "../../../bytes.ts";
import { GitError } from "../../../errors.ts";
import { parsePktLines } from "../../protocol/pkt-line.ts";

import type { GitErrorOptions } from "../../../errors.ts";
import type { V2CapabilityAdvertisement, V2CommandEntry } from "./types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * v2 能力广告解析错误
 */
export class V2CapabilityError extends GitError {
  constructor(message: string, options?: GitErrorOptions) {
    super(`v2 capability error: ${message}`, options);
    this.name = "V2CapabilityError";
  }
}

// ============================================================================
// 常量
// ============================================================================

/** Smart HTTP 服务头前缀 */
const SERVICE_HEADER_PREFIX = "# service=";

/** upload-pack 能力广告期望的 service 名 */
const EXPECTED_SERVICE = "git-upload-pack";

/** v2 能力列表中已知的命令名 */
const KNOWN_COMMANDS = ["ls-refs", "fetch", "object-info"] as const;

// ============================================================================
// 解析函数
// ============================================================================

/**
 * 解析 v2 能力广告响应
 *
 * @param data - 服务端返回的原始响应数据
 * @returns 结构化的能力广告
 * @throws {V2CapabilityError} 当格式不符合 v2 规范，或服务端未协商到 protocol v2 时
 *
 * @example
 * ```ts
 * const adv = parseV2CapabilityAdvertisement(response);
 * console.log(adv.commands); // [{ name: "ls-refs", features: [] }, ...]
 * console.log(adv.agent); // "nano-git/0.1"
 * ```
 */
export function parseV2CapabilityAdvertisement(data: Uint8Array): V2CapabilityAdvertisement {
  const lines = parsePktLines(data);

  if (lines.length === 0) {
    throw new V2CapabilityError("Empty capability advertisement");
  }

  let idx = 0;
  let sawServiceHeader = false;

  // 1. 可选跳过 Smart HTTP service 包装（# service=git-upload-pack + flush）
  //    对齐 parseRefAdvertisement / 官方 remote-curl check_smart_http
  const firstPkt = lines[idx];
  if (firstPkt && firstPkt.type === "data") {
    const firstPayload = bytesToUtf8(firstPkt.payload);
    if (firstPayload.startsWith(SERVICE_HEADER_PREFIX)) {
      const headerService = firstPayload.slice(SERVICE_HEADER_PREFIX.length).trim();
      if (headerService !== EXPECTED_SERVICE) {
        throw new V2CapabilityError(
          `Expected service "${EXPECTED_SERVICE}" but got "${headerService}"`,
        );
      }
      idx++;
      sawServiceHeader = true;

      if (idx >= lines.length || lines[idx]?.type !== "flush") {
        throw new V2CapabilityError(
          `Expected flush-pkt after service header "# service=${EXPECTED_SERVICE}"`,
        );
      }
      idx++;
    }
  }

  // 2. 要求 version 2
  const versionLine = lines[idx];
  if (!versionLine || versionLine.type !== "data") {
    throw new V2CapabilityError(
      `Expected data line as version line, got ${versionLine?.type ?? "undefined"}`,
    );
  }

  const versionStr = bytesToUtf8(versionLine.payload).trim();
  if (versionStr !== "version 2") {
    throw new V2CapabilityError(formatNonV2Error(versionStr, sawServiceHeader));
  }
  idx++;

  const capabilities: Record<string, string | true> = {};
  const commands: V2CommandEntry[] = [];

  // 3. 解析后续能力 / 命令行
  for (; idx < lines.length; idx++) {
    const line = lines[idx];
    if (!line || line.type !== "data") {
      // flush / delimiter / response-end 正常结束
      break;
    }

    const text = bytesToUtf8(line.payload).trim();
    if (text.length === 0) continue;

    // 检查是否为命令行（ls-refs, fetch, object-info 等）
    const isCommand = KNOWN_COMMANDS.some((cmd) => text === cmd || text.startsWith(`${cmd}=`));

    if (isCommand) {
      const eqIndex = text.indexOf("=");
      if (eqIndex === -1) {
        // 无附加特性：`ls-refs\n`
        const name = text;
        commands.push({ name, features: [] });
        capabilities[name] = true;
      } else {
        // 有附加特性：`fetch=shallow ref-in-want\n`
        const name = text.substring(0, eqIndex);
        const features = text
          .substring(eqIndex + 1)
          .split(" ")
          .filter((f: string) => f.length > 0);
        commands.push({ name, features });
        capabilities[name] = features.join(" ");
      }
    } else {
      // 普通能力：`agent=nano-git/0.1\n` 或 `no-progress\n`
      const eqIndex = text.indexOf("=");
      if (eqIndex === -1) {
        capabilities[text] = true;
      } else {
        const key = text.substring(0, eqIndex);
        const value = text.substring(eqIndex + 1);
        capabilities[key] = value;
      }
    }
  }

  const agent = typeof capabilities.agent === "string" ? capabilities.agent : undefined;

  return { capabilities, commands, agent };
}

/**
 * 构造「未得到 version 2」时的错误消息
 *
 * 若已剥离 Smart HTTP service 头，更可能是服务端回落到 v0；
 * 引导检查 `Git-Protocol: version=2`，避免只报首行原文。
 */
function formatNonV2Error(versionStr: string, sawServiceHeader: boolean): string {
  const preview = versionStr.length > 80 ? `${versionStr.slice(0, 80)}...` : versionStr;

  if (sawServiceHeader) {
    return (
      `Server did not negotiate protocol v2 after Smart HTTP service header ` +
      `(got "${preview}"). Ensure the request includes "Git-Protocol: version=2"; ` +
      `v0/v1 fetch is not supported`
    );
  }

  return (
    `Expected "version 2", got "${preview}". ` +
    `Ensure the request includes "Git-Protocol: version=2"; v0/v1 fetch is not supported`
  );
}

/**
 * 检测 v2 能力广告中是否包含指定命令
 *
 * @param advertisement - v2 能力广告
 * @param command - 命令名称
 * @returns 是否支持
 *
 * @example
 * ```ts
 * if (hasCommand(adv, "ls-refs")) {
 *   // 使用 ls-refs 获取 refs
 * }
 * ```
 */
export function hasCommand(advertisement: V2CapabilityAdvertisement, command: string): boolean {
  return advertisement.commands.some((cmd) => cmd.name === command);
}

/**
 * 获取命令的附加特性列表
 *
 * @param advertisement - v2 能力广告
 * @param command - 命令名称
 * @returns 特性列表，命令不存在时返回空数组
 *
 * @example
 * ```ts
 * const fetchFeatures = getCommandFeatures(adv, "fetch");
 * // ["shallow", "ref-in-want"]
 * ```
 */
export function getCommandFeatures(
  advertisement: V2CapabilityAdvertisement,
  command: string,
): string[] {
  return advertisement.commands.find((cmd) => cmd.name === command)?.features ?? [];
}
