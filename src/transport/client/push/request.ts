/**
 * 请求生成（receive-pack）
 *
 * 构造 Git receive-pack 请求 body。
 *
 * 协议 v1 的请求格式：
 *   <old-hash> <new-hash> <ref-name>\0<capabilities>\n    （首行带 capabilities）
 *   <old-hash> <new-hash> <ref-name>\n                     （后续命令）
 *   0000                                                     （flush）
 *   <packfile data>                                          （包数据，不经过 pkt-line 编码）
 *
 * @see https://git-scm.com/docs/git-receive-pack#_request
 */

import { encodePktLine, encodeFlushPkt } from "../../shared/pkt-line.ts";

import type { SHA1 } from "../../../core/types.ts";

// ============================================================================
// 类型导出
// ============================================================================

/**
 * Receive-pack 引用更新命令
 *
 * 表示一条 push 命令：将远程的 refName 从 oldHash 更新为 newHash。
 *
 * - oldHash 为 000...0 表示新建引用
 * - newHash 为 000...0 表示删除引用
 */
export interface ReceivePackCommand {
  /** 引用当前指向的哈希（服务端原有值） */
  oldHash: SHA1;
  /** 要更新到的目标哈希 */
  newHash: SHA1;
  /** 引用完整名称，如 "refs/heads/main" */
  refName: string;
}

// ============================================================================
// 请求构建
// ============================================================================

/**
 * 构建 receive-pack 请求 body
 *
 * @param commands - 引用更新命令列表（至少一个）
 * @param packfile - 包含新对象的 packfile 数据（push 时必需，delete 时可传空 Buffer）
 * @param capabilities - 能力列表（如 ["report-status", "side-band-64k", "ofs-delta"]）
 * @returns pkt-line 编码的请求 body Buffer
 *
 * @example
 * ```ts
 * const body = buildReceivePackRequest(
 *   [{ oldHash: sha1("..."), newHash: sha1("..."), refName: "refs/heads/main" }],
 *   packfile,
 *   ["report-status", "side-band-64k", "ofs-delta"],
 * );
 * ```
 */
export function buildReceivePackRequest(
  commands: ReceivePackCommand[],
  packfile: Buffer,
  capabilities: string[],
): Buffer {
  if (commands.length === 0) {
    throw new Error("At least one command is required");
  }

  const chunks: Buffer[] = [];

  // 命令行：首行带 capabilities，后续不带
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!;
    if (i === 0 && capabilities.length > 0) {
      chunks.push(
        encodePktLine(`${cmd.oldHash} ${cmd.newHash} ${cmd.refName}\0${capabilities.join(" ")}\n`),
      );
    } else {
      chunks.push(encodePktLine(`${cmd.oldHash} ${cmd.newHash} ${cmd.refName}\n`));
    }
  }

  // 命令后的 flush
  chunks.push(encodeFlushPkt());

  // packfile 数据（不经过 pkt-line 编码，直接追加）
  if (packfile.length > 0) {
    chunks.push(packfile);
  }

  return Buffer.concat(chunks);
}
