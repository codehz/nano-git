/**
 * v1 receive-pack ref 广告生成
 *
 * 处理 GET /info/refs?service=git-receive-pack 请求，
 * 生成 v1 风格的 ref 广告（含 capabilities）。
 *
 * @see https://git-scm.com/docs/pack-protocol#_git_gt_transport
 */

import { sha1 } from "../../../core/types.ts";
import { resolveRefHash } from "../../../refs/resolve.ts";
import { encodePktLine, encodeFlushPkt } from "../../shared/pkt-line.ts";
import { ZERO_HASH, SERVER_AGENT, CAPABILITIES_REF } from "./types.ts";

import type { RepositoryBackend } from "../../../backend/types.ts";

/**
 * 读取仓库中的所有引用
 */
function readAllRefs(backend: RepositoryBackend): Map<string, string> {
  const result = new Map<string, string>();

  const headContent = backend.refs.read("HEAD");
  if (headContent !== null) {
    result.set("HEAD", headContent);
  }

  const refNames = backend.refs.listAll();
  for (const ref of refNames) {
    const content = backend.refs.read(ref);
    if (content !== null) {
      result.set(ref, content);
    }
  }

  return result;
}

/**
 * 生成 v1 receive-pack 的 ref 广告
 *
 * 格式：
 * ```
 * 001e# service=git-receive-pack\n
 * 0000
 * <length><hash> <refname>\0<capabilities>\n   ← 首行 ref 携带 capabilities
 * <length><hash> <refname>\n                    ← 后续 ref
 * ...
 * 0000
 * ```
 *
 * @param backend - 仓库后端
 * @returns 完整 advertisement（pkt-line 编码）
 *
 * @example
 * ```ts
 * const buf = serveV1Advertise(backend);
 * // Response 的 Content-Type 应为 "application/x-git-receive-pack-advertisement"
 * ```
 */
export function serveV1Advertise(backend: RepositoryBackend): Buffer {
  const parts: Buffer[] = [];

  // 1. service 声明
  parts.push(encodePktLine("# service=git-receive-pack\n"));
  // 2. flush
  parts.push(encodeFlushPkt());

  // 3. ref 列表
  const refs = readAllRefs(backend);
  const capabilities = [
    "report-status",
    "delete-refs",
    "side-band-64k",
    "ofs-delta",
    "no-progress",
    `agent=${SERVER_AGENT}`,
  ];
  const capStr = capabilities.join(" ");

  let firstRef = true;

  for (const [refName, content] of refs) {
    if (content.startsWith("ref: ")) {
      // 符号引用：解析为目标哈希
      const resolved = resolveRefHash(backend.refs, refName);
      if (resolved === null) continue;

      const line = firstRef ? `${resolved} ${refName}\0${capStr}\n` : `${resolved} ${refName}\n`;

      parts.push(encodePktLine(line));

      // v1 symref 属性
      const target = content.slice(5);
      parts.push(encodePktLine(`${resolved} ${refName} symref-target:${target}\n`));

      firstRef = false;
    } else if (/^[0-9a-f]{40}$/.test(content)) {
      const hash = sha1(content);

      const line = firstRef ? `${hash} ${refName}\0${capStr}\n` : `${hash} ${refName}\n`;

      parts.push(encodePktLine(line));

      // annotated tag 的 peeled 信息（refs/tags/ 下的 tag 对象）
      if (refName.startsWith("refs/tags/")) {
        const obj = backend.objects.tryRead(hash);
        if (obj?.type === "tag") {
          parts.push(encodePktLine(`${obj.object} ${refName}^{}\n`));
        }
      }

      firstRef = false;
    }
  }

  // 当仓库为空（无任何 ref）时，发送一个占位行来携带 capabilities
  if (firstRef) {
    parts.push(encodePktLine(`${ZERO_HASH} ${CAPABILITIES_REF}\0${capStr}\n`));
  }

  // 4. 结尾 flush
  parts.push(encodeFlushPkt());

  return Buffer.concat(parts);
}
