/**
 * 高层 fetch 编排
 *
 * 编排完整的 Smart HTTP fetch 流程：
 * 1. 获取远程引用广告
 * 2. 按 refspec 确定要拉取的引用
 * 3. 构造 upload-pack 请求
 * 4. 解析 packfile 并写入本地存储
 * 5. 更新远程跟踪引用
 *
 * @example
 * ```ts
 * import { initRepository } from "./repository/index.ts";
 * import { fetch } from "./transport/fetch.ts";
 *
 * const repo = initRepository("/tmp/my-repo");
 * const result = await fetch(repo.objects, repo.refs, "https://github.com/user/repo");
 * console.log(`Fetched ${result.objectCount} objects`);
 * ```
 */

import type { ObjectStore } from "../odb/types.ts";
import type { RefStore } from "../refs/types.ts";
import { HEADS_PREFIX, TAGS_PREFIX, HEAD_REF } from "../refs/types.ts";
import type { SHA1 } from "../core/types.ts";
import { sha1 } from "../core/types.ts";
import { createPackReader } from "../odb/pack/pack-reader.ts";
import { deserializeContent } from "../objects/codec.ts";
import { createSmartHttpClient } from "./smart-http.ts";
import { buildUploadPackRequest } from "./negotiate.ts";
import type { FetchOptions, FetchResult } from "./types.ts";
import type { RemoteRef } from "./types.ts";
import { GitError } from "../core/errors.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * Fetch 操作错误
 */
export class FetchError extends GitError {
  constructor(message: string) {
    super(`Fetch error: ${message}`);
    this.name = "FetchError";
  }
}

// ============================================================================
// 常量
// ============================================================================

/** 默认 refspec */
const DEFAULT_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

/** Git 协议 v1 常用能力 */
const DEFAULT_CAPABILITIES = [
  "multi_ack",
  "side-band-64k",
  "ofs-delta",
  "no-progress",
  "include-tag",
];

// ============================================================================
// 辅助类型
// ============================================================================

/** 解析后的 refspec */
export interface ParsedRefSpec {
  force: boolean;
  srcPattern: string;
  dstPattern: string;
}

// ============================================================================
// RefSpec 解析
// ============================================================================

/**
 * 解析 refspec 字符串
 *
 * 格式: [+]<src>:<dst>
 * 其中 + 表示 force push/fetch
 * * 是通配符
 *
 * @example
 * ```ts
 * parseRefSpec("+refs/heads/*:refs/remotes/origin/*")
 * // => { force: true, srcPattern: "refs/heads/", dstPattern: "refs/remotes/origin/" }
 * ```
 */
export function parseRefSpec(refSpec: string): ParsedRefSpec {
  const force = refSpec.startsWith("+");
  const spec = force ? refSpec.slice(1) : refSpec;

  const colonIndex = spec.indexOf(":");
  if (colonIndex === -1) {
    throw new FetchError(`Invalid refspec: "${refSpec}" (missing ":")`);
  }

  const src = spec.substring(0, colonIndex);
  const dst = spec.substring(colonIndex + 1);

  // 处理通配符
  const srcPattern = src.replace(/\*$/, "");
  const dstPattern = dst.replace(/\*$/, "");

  return { force, srcPattern, dstPattern };
}

/**
 * 判断远程引用是否匹配 refspec 源模式
 */
export function matchesRefSpec(ref: RemoteRef, spec: ParsedRefSpec): boolean {
  return ref.name.startsWith(spec.srcPattern);
}

/**
 * 将远程引用名转换为本地引用名
 */
export function mapRefName(refName: string, spec: ParsedRefSpec): string {
  const suffix = refName.slice(spec.srcPattern.length);
  return `${spec.dstPattern}${suffix}`;
}

/**
 * 按 refspec 过滤远程引用并确定 wants
 *
 * @param remoteRefs - 远程引用列表
 * @param localRefs - 本地 ref → hash 映射
 * @param refSpecs - refspec 列表
 * @returns wants（需要拉取的远程引用及其本地 ref 名）
 */
export function determineWants(
  remoteRefs: RemoteRef[],
  localRefs: Map<string, SHA1>,
  refSpecs: ParsedRefSpec[],
): Array<{ remote: RemoteRef; localName: string }> {
  const wants: Array<{ remote: RemoteRef; localName: string }> = [];

  for (const ref of remoteRefs) {
    for (const spec of refSpecs) {
      if (!matchesRefSpec(ref, spec)) continue;

      const localName = mapRefName(ref.name, spec);

      // 检查本地是否已是最新
      const localHash = localRefs.get(localName);
      if (localHash === ref.hash) {
        continue; // 已是最新，跳过
      }

      wants.push({ remote: ref, localName });
    }
  }

  return wants;
}

/**
 * 获取本地 refs 的哈希映射
 *
 * 遍历 refs/heads/、refs/tags/ 和 HEAD 等已知前缀，
 * 避免使用 "refs/" 顶级前缀（不满足 validateRefPrefix 要求）。
 */
function getLocalRefs(refs: RefStore): Map<string, SHA1> {
  const map = new Map<string, SHA1>();
  const prefixes = [HEADS_PREFIX, TAGS_PREFIX, "refs/remotes/"];

  // 明确检查的引用
  const explicitRefs = [HEAD_REF];

  for (const prefix of prefixes) {
    for (const refName of refs.listRaw(prefix)) {
      const content = refs.readRaw(refName);
      if (content && /^[0-9a-f]{40}$/.test(content)) {
        try {
          map.set(refName, sha1(content));
        } catch {
          // 忽略无效哈希
        }
      }
    }
  }

  for (const refName of explicitRefs) {
    const content = refs.readRaw(refName);
    if (content && /^[0-9a-f]{40}$/.test(content)) {
      try {
        map.set(refName, sha1(content));
      } catch {
        // 忽略无效哈希
      }
    }
  }

  return map;
}

// ============================================================================
// Fetch 编排
// ============================================================================

/**
 * 执行 fetch 操作
 *
 * 从远程 Git 仓库拉取对象和引用更新。
 *
 * @param store - 本地对象存储
 * @param refs - 本地引用存储
 * @param url - 远程仓库 URL（如 "https://github.com/user/repo"）
 * @param options - 可选配置
 * @returns fetch 操作结果
 *
 * @example
 * ```ts
 * const result = await fetch(repo.objects, repo.refs, "https://github.com/user/repo");
 * console.log(`Fetched ${result.objectCount} objects`);
 * ```
 */
export async function fetch(
  store: ObjectStore,
  refs: RefStore,
  url: string,
  options?: FetchOptions,
): Promise<FetchResult> {
  const client = createSmartHttpClient(url, {
    token: options?.token,
    headers: options?.headers,
  });

  // 1. 获取远程引用广告
  const adv = await client.getRefAdvertisement();

  // 2. 解析 refspec
  const refSpecStr = options?.refSpecs ?? [DEFAULT_REFSPEC];
  const parsedSpecs = refSpecStr.map(parseRefSpec);

  // 3. 获取本地 refs
  const localRefs = getLocalRefs(refs);

  // 4. 确定 wants
  const wants = determineWants(adv.refs, localRefs, parsedSpecs);

  if (wants.length === 0) {
    return {
      fetchedRefs: new Map(),
      objectCount: 0,
    };
  }

  // 5. 从服务端 capabilities 中确定可用能力
  const caps = extractCapabilities(adv.capabilities);

  // 6. 构造请求（初始实现：空 haves，后续支持增量 fetch）
  const wantHashes = wants.map((w) => w.remote.hash);
  const body = buildUploadPackRequest(wantHashes, [], caps);

  // 7. 发送请求
  const { packfile } = await client.postUploadPack(body);

  if (packfile.length === 0) {
    throw new FetchError("Server returned empty packfile");
  }

  // 8. 解析 packfile 并写入对象
  const reader = createPackReader(packfile);
  let objectCount = 0;

  for (const packObj of reader.objects()) {
    try {
      const gitObj = deserializeContent(packObj.type, packObj.data);
      store.write(gitObj);
      objectCount++;
    } catch (err) {
      // 如果某个对象写入失败，继续处理其余对象
      // 但记录错误以便调试
      if (err instanceof Error) {
        throw new FetchError(`Failed to write object ${packObj.hash}: ${err.message}`);
      }
    }
  }

  // 9. 更新远程跟踪引用
  const fetchedRefs = new Map<string, SHA1>();
  for (const { localName, remote } of wants) {
    refs.writeRaw(localName, remote.hash);
    fetchedRefs.set(localName, remote.hash);
  }

  return {
    fetchedRefs,
    objectCount,
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从服务端 capabilities 中提取客户端可用的能力列表
 *
 * 客户端声明它想要的能力，服务端在响应中报告它支持的能力。
 * 这里取客户端默认能力与服务端支持能力的交集。
 */
function extractCapabilities(serverCaps: Record<string, string | true>): string[] {
  const supported = new Set<string>(DEFAULT_CAPABILITIES);
  // 只使用服务端也支持的能力
  return Object.keys(serverCaps).filter((cap) => supported.has(cap));
}
