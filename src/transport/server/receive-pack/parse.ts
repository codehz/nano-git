/**
 * v1 receive-pack 请求解析
 *
 * 解析客户端 POST 的 ref 命令与 capabilities。
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
 * @see https://git-scm.com/docs/pack-protocol#_git_gt_transport
 */

import { sha1 } from "../../../core/types.ts";
import { splitPktLinesFromBuffer } from "../../shared/pkt-line.ts";
import { V1ReceivePackError } from "./types.ts";

import type { V1ReceivePackCommand, ParsedV1ReceivePackRequest } from "./types.ts";

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

/**
 * 解析 v1 receive-pack push 请求 body
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
