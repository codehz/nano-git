/**
 * v2 能力广告解析
 *
 * 解析 Git Wire 协议 v2 的 capability advertisement 响应。
 *
 * v2 能力广告格式：
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
 * @see https://git-scm.com/docs/protocol-v2#_capability_advertisement
 */

import { GitError } from "../../core/errors.ts";
import { parsePktLines } from "../shared/pkt-line.ts";

import type { V2CapabilityAdvertisement, V2CommandEntry } from "./types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * v2 能力广告解析错误
 */
export class V2CapabilityError extends GitError {
  constructor(message: string) {
    super(`v2 capability error: ${message}`);
    this.name = "V2CapabilityError";
  }
}

// ============================================================================
// 解析函数
// ============================================================================

/**
 * 解析 v2 能力广告响应
 *
 * @param data - 服务端返回的原始响应数据
 * @returns 结构化的能力广告
 * @throws {V2CapabilityError} 当格式不符合 v2 规范时
 *
 * @example
 * ```ts
 * const adv = parseV2CapabilityAdvertisement(response);
 * console.log(adv.commands); // [{ name: "ls-refs", features: [] }, ...]
 * console.log(adv.agent); // "nano-git/0.1"
 * ```
 */
export function parseV2CapabilityAdvertisement(data: Buffer): V2CapabilityAdvertisement {
  const lines = parsePktLines(data);

  if (lines.length === 0) {
    throw new V2CapabilityError("Empty capability advertisement");
  }

  const firstLine = lines[0];
  if (!firstLine || firstLine.type !== "data") {
    throw new V2CapabilityError(
      `Expected data line as first line, got ${firstLine?.type ?? "undefined"}`,
    );
  }

  const versionStr = firstLine.payload.toString("utf-8").trim();
  if (versionStr !== "version 2") {
    throw new V2CapabilityError(`Expected "version 2", got "${versionStr}"`);
  }

  const capabilities: Record<string, string | true> = {};
  const commands: V2CommandEntry[] = [];

  // 解析后续行（跳过第一行 version 2）
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.type !== "data") {
      // flush / delimiter / response-end 正常结束
      break;
    }

    const text = line.payload.toString("utf-8").trim();
    if (text.length === 0) continue;

    // 检查是否为命令行（ls-refs, fetch, push, object-info 等）
    const knownCommands = ["ls-refs", "fetch", "push", "object-info"];
    const isCommand = knownCommands.some((cmd) => text.startsWith(cmd));

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
