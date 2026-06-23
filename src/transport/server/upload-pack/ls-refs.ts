/**
 * v2 ls-refs 命令响应生成
 *
 * 处理 ls-refs 命令，按 ref-prefix 过滤并生成 ref 列表响应。
 *
 * @see https://git-scm.com/docs/protocol-v2#_ls_refs
 */

import { sha1 } from "../../../core/types.ts";
import { resolveRefHash } from "../../../refs/resolve.ts";
import { encodePktLine, encodeFlushPkt } from "../../shared/pkt-line.ts";

import type { RepositoryBackend } from "../../../backend/types.ts";

/** ls-refs 请求中解析出的选项 */
export interface LsRefsServerOptions {
  readonly symrefs: boolean;
  readonly peel: boolean;
  readonly unborn: boolean;
  readonly refPrefixes: string[];
}

/**
 * 从 args 中解析 ls-refs 选项
 *
 * @param args - ls-refs 命令的 args 列表
 * @returns 结构化的 ls-refs 选项
 *
 * @example
 * ```ts
 * const opts = parseLsRefsArgs(["symrefs", "peel", "ref-prefix refs/heads/"]);
 * // { symrefs: true, peel: true, unborn: false, refPrefixes: ["refs/heads/"] }
 * ```
 */
export function parseLsRefsArgs(args: string[]): LsRefsServerOptions {
  const prefixes: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("ref-prefix ")) {
      prefixes.push(arg.slice(11).trim());
    }
  }

  return {
    symrefs: args.includes("symrefs"),
    peel: args.includes("peel"),
    unborn: args.includes("unborn"),
    refPrefixes: prefixes,
  };
}

/**
 * 读取仓库中的所有引用
 *
 * 包含 HEAD 和 refs/ 下的所有引用，返回名称到原始内容的映射。
 * 原始内容可能是 SHA-1 哈希或以 "ref: " 开头的符号引用。
 */
function readAllRefs(backend: RepositoryBackend): Map<string, string> {
  const result = new Map<string, string>();

  // HEAD（可能在 refs/ 外部）
  const headContent = backend.refs.read("HEAD");
  if (headContent !== null) {
    result.set("HEAD", headContent);
  }

  // refs/ 下的所有引用
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
 * 按 ref-prefix 过滤引用
 *
 * HEAD 始终包含（因为它可能符号引用到 unborn branch）。
 */
function filterRefsByPrefix(refs: Map<string, string>, prefixes: string[]): Map<string, string> {
  if (prefixes.length === 0) {
    return refs;
  }

  const result = new Map<string, string>();
  for (const [name, content] of refs) {
    if (name === "HEAD") {
      result.set(name, content);
      continue;
    }
    for (const prefix of prefixes) {
      if (name.startsWith(prefix)) {
        result.set(name, content);
        break;
      }
    }
  }
  return result;
}

/**
 * 生成 ls-refs 响应
 *
 * @param backend - 仓库后端
 * @param options - ls-refs 选项
 * @returns pkt-line 编码的 ls-refs 响应
 *
 * @example
 * ```ts
 * const buf = generateLsRefsResponse(backend, { symrefs: true, peel: true, unborn: false, refPrefixes: [] });
 * ```
 */
export function generateLsRefsResponse(
  backend: RepositoryBackend,
  options: LsRefsServerOptions,
): Buffer {
  const rawRefs = readAllRefs(backend);
  const filtered = filterRefsByPrefix(rawRefs, options.refPrefixes);
  const lines: Buffer[] = [];

  for (const [refName, content] of filtered) {
    if (content === null || content.length === 0) continue;

    if (content.startsWith("ref: ")) {
      // 符号引用
      const target = content.slice(5);
      const resolved = resolveRefHash(backend.refs, refName);

      if (resolved === null && !options.unborn) {
        // unborn 且未请求 unborn 信息，跳过
        continue;
      }

      const oid = resolved ?? "unborn";
      const attrs: string[] = [];

      if (options.symrefs) {
        attrs.push(`symref-target:${target}`);
      }

      const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
      lines.push(encodePktLine(`${oid} ${refName}${attrStr}\n`));
    } else if (/^[0-9a-f]{40}$/.test(content)) {
      // 直接引用（SHA-1）
      const oid = sha1(content);
      const attrs: string[] = [];

      // annotated tag 且请求了 peel
      if (options.peel && refName.startsWith("refs/tags/")) {
        const obj = backend.objects.tryRead(oid);
        if (obj?.type === "tag") {
          attrs.push(`peeled:${obj.object}`);
        }
      }

      const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
      lines.push(encodePktLine(`${oid} ${refName}${attrStr}\n`));
    }
    // 其他内容格式跳过（不合法引用条目）
  }

  lines.push(encodeFlushPkt());
  return Buffer.concat(lines);
}
