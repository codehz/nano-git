/**
 * upload-pack 能力广告生成
 *
 * 生成 upload-pack 的 v2 能力广告。
 */

import { encodePktLine, encodeFlushPkt } from "../../protocol/pkt-line.ts";
import { SERVER_AGENT } from "./types.ts";

/**
 * 生成 v2 能力广告
 *
 * @returns 完整的 pkt-line 编码能力广告
 *
 * @example
 * ```ts
 * const response = advertiseUploadPack();
 * // "000eversion 2\n000bls-refs\n...0000"
 * ```
 */
export function advertiseUploadPack(): Buffer {
  const parts: Buffer[] = [];

  parts.push(encodePktLine("version 2\n"));
  parts.push(encodePktLine("ls-refs\n"));
  parts.push(encodePktLine("fetch=shallow ref-in-want filter\n"));

  parts.push(encodePktLine(`agent=${SERVER_AGENT}\n`));
  parts.push(encodeFlushPkt());

  return Buffer.concat(parts);
}
