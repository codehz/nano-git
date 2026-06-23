/**
 * v2 ls-refs 命令
 *
 * 在 Git Wire 协议 v2 中，ls-refs 替代了 v1 的 ref advertisement。
 * 服务端通过独立的 `ls-refs` 命令返回引用列表。
 *
 * 请求格式：
 * ```
 * command=ls-refs\n
 * agent=nano-git/0.1\n
 * 0001
 * symrefs\n
 * peel\n
 * ref-prefix refs/heads/\n
 * 0000
 * ```
 *
 * 响应格式：
 * ```
 * <oid> <refname>[ <attr>...]\n
 * ...
 * 0000
 * ```
 *
 * @see https://git-scm.com/docs/protocol-v2#_ls_refs
 */

import { GitError } from "../../core/errors.ts";
import { sha1 } from "../../core/types.ts";
import { parsePktLines } from "../shared/pkt-line.ts";

import type { RemoteRef } from "../shared/types.ts";
import type { RefAdvertisement } from "../v1/types.ts";
import type { V2GitServiceTransport, LsRefsEntry } from "./types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * ls-refs 命令错误
 */
export class LsRefsError extends GitError {
  constructor(message: string) {
    super(`ls-refs error: ${message}`);
    this.name = "LsRefsError";
  }
}

// ============================================================================
// LsRefsRequest 构建
// ============================================================================

/**
 * ls-refs 请求参数
 */
export interface LsRefsOptions {
  /** 请求符号引用信息 */
  readonly symrefs?: boolean;
  /** 请求 peeled tag 信息 */
  readonly peel?: boolean;
  /** 按前缀过滤 refs，如 ["refs/heads/", "refs/tags/"] */
  readonly refPrefixes?: string[];
  /** 请求 unborn HEAD 信息 */
  readonly unborn?: boolean;
}

/**
 * 执行 ls-refs 命令
 *
 * @param transport - v2 传输接口
 * @param options - ls-refs 请求选项
 * @returns 解析后的 ref 条目列表
 *
 * @example
 * ```ts
 * const entries = await lsRefs(transport, {
 *   symrefs: true,
 *   peel: true,
 *   refPrefixes: ["refs/heads/"],
 * });
 * ```
 */
export async function lsRefs(
  transport: V2GitServiceTransport,
  options?: LsRefsOptions,
): Promise<LsRefsEntry[]> {
  const args: string[] = [];

  if (options?.symrefs) {
    args.push("symrefs");
  }
  if (options?.peel) {
    args.push("peel");
  }
  if (options?.unborn) {
    args.push("unborn");
  }
  if (options?.refPrefixes) {
    for (const prefix of options.refPrefixes) {
      args.push(`ref-prefix ${prefix}`);
    }
  }

  const response = await transport.command("ls-refs", args);

  return parseLsRefsResponse(response);
}

// ============================================================================
// 响应解析
// ============================================================================

/**
 * 解析 ls-refs 响应
 *
 * 从原始 Buffer 中解析 ls-refs 条目。
 *
 * @param data - ls-refs 命令的原始响应数据
 * @returns 解析后的 ref 条目列表
 *
 * @example
 * ```ts
 * const entries = parseLsRefsResponse(response);
 * console.log(entries[0].refname); // "refs/heads/main"
 * ```
 */
export function parseLsRefsResponse(data: Buffer): LsRefsEntry[] {
  const lines = parsePktLines(data);
  const entries: LsRefsEntry[] = [];

  for (const line of lines) {
    if (line.type !== "data") continue;

    const text = line.payload.toString("utf-8").trim();
    if (text.length === 0) continue;

    // 格式: <obj-id-or-unborn> SP <refname> [SP <attr>...] LF
    const spaceIdx = text.indexOf(" ");
    if (spaceIdx === -1) continue;

    const oid = text.substring(0, spaceIdx);
    const rest = text.substring(spaceIdx + 1).trim();

    // 分离 refname 和属性
    const parts = rest.split(" ");
    const refname = parts[0]!;

    const entry: {
      oid: string;
      refname: string;
      symrefTarget?: string;
      peeled?: string;
    } = { oid, refname };

    // 解析属性（从索引 1 开始）
    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i]!;
      if (attr.startsWith("symref-target:")) {
        entry.symrefTarget = attr.substring("symref-target:".length);
      } else if (attr.startsWith("peeled:")) {
        entry.peeled = attr.substring("peeled:".length);
      }
    }

    entries.push(entry as LsRefsEntry);
  }

  return entries;
}

// ============================================================================
// 转换函数：LsRefsEntry[] → v1 RefAdvertisement
// ============================================================================

/**
 * 将 v2 ls-refs 结果转换为 v1 兼容的 RefAdvertisement
 *
 * 用于 ImportSession 的透明升级：v2 获取 refs 后，
 * 包装为 v1 的 RefAdvertisement 格式，使上游代码无需改动。
 *
 * @param entries - ls-refs 返回的 ref 条目
 * @returns v1 兼容的 RefAdvertisement
 *
 * @example
 * ```ts
 * const entries = await lsRefs(transport);
 * const adv = lsRefsToRefAdvertisement(entries);
 * // 可传递给 ImportSession
 * ```
 */
export function lsRefsToRefAdvertisement(entries: LsRefsEntry[]): RefAdvertisement {
  const refs: RemoteRef[] = [];
  let defaultBranch: string | undefined;

  // 用于暂存 peeled tag 信息：refname → peeled hash
  const peeledMap = new Map<string, string>();

  // 第一遍：收集 peeled 信息和 ^{} 条目
  for (const entry of entries) {
    if (entry.peeled) {
      // v2 中将 peeled 信息放在 ^{} 条目的 peeled 属性中
      const baseName = entry.refname.endsWith("^{}") ? entry.refname.slice(0, -3) : entry.refname;
      peeledMap.set(baseName, entry.peeled);
    }
  }

  for (const entry of entries) {
    // 跳过 unborn 条目和 ^{} 虚拟条目
    if (entry.oid === "unborn") continue;
    if (entry.refname.endsWith("^{}")) continue;

    const hash = sha1(entry.oid);
    const ref: RemoteRef = {
      hash,
      name: entry.refname,
    };

    if (entry.symrefTarget) {
      ref.symrefTarget = entry.symrefTarget;
    }

    // 从暂存 map 中补充 peeled 信息
    const peeled = peeledMap.get(entry.refname);
    if (peeled) {
      ref.peeled = sha1(peeled);
    }

    refs.push(ref);

    // 从 HEAD 的 symrefTarget 推断 defaultBranch
    if (entry.refname === "HEAD" && entry.symrefTarget) {
      defaultBranch = entry.symrefTarget;
    }
  }

  // 空仓库或 unborn 场景：fallback
  if (!defaultBranch && refs.length > 0) {
    const mainBranch = refs.find(
      (r) => r.name === "refs/heads/main" || r.name === "refs/heads/master",
    );
    if (mainBranch) {
      defaultBranch = mainBranch.name;
    }
  }

  return {
    capabilities: {},
    refs,
    defaultBranch,
  };
}
