/**
 * v2 命令请求解析
 *
 * 解析 v2 协议中 command/capability/args 三段式请求体。
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
 * @see https://git-scm.com/docs/protocol-v2#_request
 */

import { parsePktLines } from "../../protocol/pkt-line.ts";

/**
 * 解析后的命令请求
 */
export interface ParsedCommandRequest {
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
 * @param body - 完整的请求体（pkt-line 编码）
 * @returns 解析后的命令信息
 *
 * @example
 * ```ts
 * const cmd = parseCommandRequest(body);
 * console.log(cmd.command); // "ls-refs"
 * ```
 */
export function parseCommandRequest(body: Buffer): ParsedCommandRequest {
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
