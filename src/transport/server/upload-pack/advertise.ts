/**
 * v2 能力广告生成
 *
 * 处理 GET /info/refs?service=git-upload-pack 请求，
 * 生成 v2 协议的能力广告。
 */

import { encodePktLine, encodeFlushPkt } from "../../protocol/pkt-line.ts";
import { SERVER_AGENT, V2ServeError } from "./types.ts";

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
