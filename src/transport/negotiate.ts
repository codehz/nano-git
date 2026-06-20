/**
 * 请求生成（negotiate）
 *
 * 构造 Git upload-pack 请求 body。
 *
 * 协议 v1 的请求格式：
 *   want <hash> <capabilities>\n    （首行带 capabilities）
 *   want <hash>\n                    （后续 want）
 *   0000                             （flush）
 *   have <hash>\n                    （批量，每批 ≤ 32 条后加 flush）
 *   0000
 *   done\n
 *   0000
 *
 * @see https://git-scm.com/docs/git-upload-pack#_request
 */

import { encodePktLine, encodeFlushPkt } from "./pkt-line.ts";
import type { SHA1 } from "../core/types.ts";

// ============================================================================
// 常量
// ============================================================================

/** 每批 have 的最大数量（Git 协议建议 ≤ 32） */
const MAX_HAVES_PER_BATCH = 32;

/**
 * 构建 upload-pack 请求 body
 *
 * @param wants - 请求的 want 对象哈希列表（至少一个）
 * @param haves - 已有的 have 对象哈希列表（增量 fetch 时用）
 * @param capabilities - 能力列表（如 ["multi_ack", "side-band-64k", "ofs-delta"]）
 * @returns pkt-line 编码的请求 body Buffer
 *
 * @example
 * ```ts
 * const body = buildUploadPackRequest(
 *   [sha1("95d09f2b...")],
 *   [],
 *   ["multi_ack", "side-band-64k", "ofs-delta"],
 * );
 * // => "want 95d09f2b... multi_ack side-band-64k ofs-delta\n"
 * //   + "0000"
 * //   + "done\n"
 * //   + "0000"
 * ```
 */
export function buildUploadPackRequest(
  wants: SHA1[],
  haves: SHA1[],
  capabilities: string[],
): Buffer {
  if (wants.length === 0) {
    throw new Error("At least one want is required");
  }

  const chunks: Buffer[] = [];

  // want 行：首行带 capabilities，后续不带
  for (let i = 0; i < wants.length; i++) {
    const hash = wants[i]!;
    if (i === 0 && capabilities.length > 0) {
      chunks.push(encodePktLine(`want ${hash} ${capabilities.join(" ")}\n`));
    } else {
      chunks.push(encodePktLine(`want ${hash}\n`));
    }
  }

  // want 后的 flush
  chunks.push(encodeFlushPkt());

  // have 行：批量发送，每批 MAX_HAVES_PER_BATCH 条后加 flush
  for (let i = 0; i < haves.length; i++) {
    if (i > 0 && i % MAX_HAVES_PER_BATCH === 0) {
      chunks.push(encodeFlushPkt());
    }
    chunks.push(encodePktLine(`have ${haves[i]!}\n`));
  }

  // have 后的 flush（如果有 haves）
  if (haves.length > 0) {
    chunks.push(encodeFlushPkt());
  }

  // done 命令
  chunks.push(encodePktLine("done\n"));
  chunks.push(encodeFlushPkt());

  return Buffer.concat(chunks);
}
