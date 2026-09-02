/**
 * upload-pack 能力广告生成
 *
 * 生成 upload-pack 的 v2 能力广告。
 */

import { concatBytes } from "../../../bytes.ts";
import { encodePktLine, encodeFlushPkt } from "../../protocol/pkt-line.ts";
import { SERVER_AGENT, SERVER_OBJECT_FORMAT } from "./types.ts";

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
export function advertiseUploadPack(): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodePktLine("version 2\n"));
  // 与官方 git-http-backend 的默认广告保持接近：
  // - ls-refs 显式带 unborn
  // - fetch 默认仅广告 shallow / wait-for-done
  // - object-format 作为顶层能力单独广告
  parts.push(encodePktLine("ls-refs=unborn\n"));
  parts.push(encodePktLine("fetch=shallow wait-for-done\n"));
  parts.push(encodePktLine("server-option\n"));
  parts.push(encodePktLine(`object-format=${SERVER_OBJECT_FORMAT}\n`));
  parts.push(encodePktLine(`agent=${SERVER_AGENT}\n`));
  parts.push(encodeFlushPkt());

  return concatBytes(...parts);
}
