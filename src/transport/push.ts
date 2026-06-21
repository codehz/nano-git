/**
 * 高层 push 编排
 *
 * 编排完整的 Smart HTTP push 流程：
 * 1. 获取远程 receive-pack ref 广告
 * 2. 按 refspec 确定要推送的本地引用与远程目标
 * 3. 收集需要发送的对象（推送 ref 可达且远程缺失的对象）
 * 4. 构建 packfile
 * 5. 构造 receive-pack 请求并发送
 * 6. 解析 report-status 响应
 *
 * @example
 * ```ts
 * import { initRepository } from "./repository/index.ts";
 * import { push } from "./transport/push.ts";
 *
 * const repo = initRepository("/tmp/my-repo");
 * const result = await push(repo.objects, repo.refs, "https://github.com/user/repo");
 * console.log(`Pushed ${result.objectCount} objects`);
 * ```
 */

import type { ObjectStore } from "../odb/types.ts";
import type { RefStore } from "../refs/types.ts";
import { HEADS_PREFIX, HEAD_REF, resolveRefHash } from "../refs/index.ts";
import type { SHA1 } from "../core/types.ts";
import { sha1 } from "../core/types.ts";
import { createPackWriter } from "../odb/pack/pack-writer.ts";
import { createSmartHttpClient } from "./smart-http.ts";
import { buildReceivePackRequest } from "./receive-pack-request.ts";
import { ReceivePackResultError } from "./receive-pack-result.ts";
import type { PushOptions, PushResult, PushRefUpdate } from "./types.ts";
import { parseRefSpec, matchesRefSpec } from "./fetch.ts";
import type { ParsedRefSpec } from "./fetch.ts";
import { GitError } from "../core/errors.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * Push 操作错误
 */
export class PushError extends GitError {
  constructor(message: string) {
    super(`Push error: ${message}`);
    this.name = "PushError";
  }
}

// ============================================================================
// 常量
// ============================================================================

/** 默认 refspec */
const DEFAULT_REFSPEC = "HEAD:refs/heads/main";

/** Git 协议 v1 receive-pack 常用能力 */
const DEFAULT_CAPABILITIES = [
  "report-status",
  "side-band-64k",
  "ofs-delta",
  "no-progress",
  "delete-refs",
];

/** 零哈希（表示新建引用或删除引用） */
const ZERO_HASH = "0000000000000000000000000000000000000000";

// ============================================================================
// 可达性遍历（纯 ObjectStore 版本）
// ============================================================================

/**
 * 从指定哈希出发，收集所有可达的对象哈希
 *
 * 递归遍历 commit（tree + parents）、tree（entries）、tag（object）。
 *
 * @param objects - 对象存储
 * @param hash - 起始对象哈希
 * @param reachable - 用于收集结果的可达集合
 */
/**
 * 从指定哈希出发，递归收集所有可达对象哈希
 *
 * @param objects - 对象存储
 * @param hash - 起始对象哈希
 * @param reachable - 用于收集结果的可达集合
 * @param missing - 遇到缺失对象时的行为：
 *   - `"skip"`（默认）：静默跳过，用于远程排除计算
 *   - `"throw"`：抛出 PushError，用于本地可达性校验
 */
function collectReachableFrom(
  objects: ObjectStore,
  hash: SHA1,
  reachable: Set<SHA1>,
  missing: "throw" | "skip" = "skip",
): void {
  if (reachable.has(hash)) {
    return;
  }

  if (!objects.exists(hash)) {
    if (missing === "throw") {
      throw new PushError(
        `Object ${hash} is missing from the local store. ` +
          `The local repository may be incomplete or corrupted. ` +
          `Try fetching or running a repair before pushing.`,
      );
    }
    return;
  }

  reachable.add(hash);
  const obj = objects.read(hash);

  switch (obj.type) {
    case "blob":
      return;
    case "tree":
      for (const entry of obj.entries) {
        collectReachableFrom(objects, entry.hash, reachable, missing);
      }
      return;
    case "commit":
      collectReachableFrom(objects, obj.tree, reachable, missing);
      for (const parent of obj.parents) {
        collectReachableFrom(objects, parent, reachable, missing);
      }
      return;
    case "tag":
      collectReachableFrom(objects, obj.object, reachable, missing);
      return;
  }
}

/**
 * 从多个起始点收集所有可达对象哈希
 *
 * @param missing - 遇到缺失对象时的行为，透传给 collectReachableFrom
 *
 * @internal 导出仅用于测试
 */
export function collectReachable(
  objects: ObjectStore,
  roots: SHA1[],
  missing: "throw" | "skip" = "skip",
): Set<SHA1> {
  const reachable = new Set<SHA1>();
  for (const hash of roots) {
    collectReachableFrom(objects, hash, reachable, missing);
  }
  return reachable;
}

// ============================================================================
// 推送引用解析
// ============================================================================

/**
 * 要推送的引用项
 */
interface PushRefItem {
  /** 本地引用名称（删除操作时为空字符串） */
  localRef: string;
  /** 远程目标引用名称 */
  remoteRef: string;
  /** 本地 ref 当前指向的哈希（null 表示删除远程引用） */
  localHash: SHA1 | null;
  /** 远程 ref 当前指向的哈希（null 表示新建） */
  remoteHash: SHA1 | null;
  /** 是否强制推送 */
  force: boolean;
}

/**
 * 解析 refspec 并确定要推送的引用列表
 *
 * 根据 refspec 匹配本地引用，并与远程引用对照。
 *
 * @param localRefs - 本地 ref → hash 映射
 * @param remoteRefs - 远程 ref → hash 映射
 * @param specs - 解析后的 refspec 列表
 * @returns 要推送的引用项列表
 *
 * @internal 导出仅用于测试
 */
export function determinePushRefs(
  localRefs: Map<string, SHA1>,
  remoteRefs: Map<string, SHA1>,
  specs: ParsedRefSpec[],
): PushRefItem[] {
  const items: PushRefItem[] = [];

  for (const spec of specs) {
    const isWildcard = spec.srcPattern.endsWith("/");

    if (isWildcard) {
      // 通配符 refspec：匹配所有以 srcPattern 开头的本地引用
      for (const [localRef, localHash] of localRefs) {
        if (!localRef.startsWith(spec.srcPattern)) continue;

        const suffix = localRef.slice(spec.srcPattern.length);
        const remoteRef = `${spec.dstPattern}${suffix}`;
        const remoteHash = remoteRefs.get(remoteRef) ?? null;

        items.push({
          localRef,
          remoteRef,
          localHash: localHash,
          remoteHash,
          force: spec.force,
        });
      }
    } else if (spec.srcPattern === "") {
      // 删除引用：refspec 源为空，如 ":refs/heads/feature"
      const remoteHash = remoteRefs.get(spec.dstPattern) ?? null;
      items.push({
        localRef: "",
        remoteRef: spec.dstPattern,
        localHash: null,
        remoteHash,
        force: spec.force,
      });
    } else {
      // 精确 refspec
      const remoteRef = spec.dstPattern;
      const localHash = localRefs.get(spec.srcPattern) ?? null;

      if (!localHash) {
        throw new PushError(
          `Local ref not found: "${spec.srcPattern}" (specified in refspec "${spec.srcPattern}:${spec.dstPattern}")`,
        );
      }

      const remoteHash = remoteRefs.get(remoteRef) ?? null;
      items.push({
        localRef: spec.srcPattern,
        remoteRef,
        localHash,
        remoteHash,
        force: spec.force,
      });
    }
  }

  return items;
}

/**
 * 获取本地 refs 的哈希映射
 *
 * 遍历 refs/heads/、refs/tags/ 和 HEAD。
 */
function getLocalRefs(refs: RefStore): Map<string, SHA1> {
  const map = new Map<string, SHA1>();

  // 遍历 refs/heads/
  for (const refName of refs.listRaw(HEADS_PREFIX)) {
    const content = refs.readRaw(refName);
    if (content && /^[0-9a-f]{40}$/.test(content)) {
      try {
        map.set(refName, sha1(content));
      } catch {
        // 忽略无效哈希
      }
    }
  }

  // HEAD 特殊处理
  const headHash = resolveRefHash(refs, HEAD_REF);
  if (headHash) {
    map.set(HEAD_REF, headHash);
  }

  return map;
}

/**
 * 将远程 ref 广告转换为哈希映射
 */
function remoteRefsToMap(refs: Array<{ name: string; hash: SHA1 }>): Map<string, SHA1> {
  const map = new Map<string, SHA1>();
  for (const ref of refs) {
    map.set(ref.name, ref.hash);
  }
  return map;
}

// ============================================================================
// Push 辅助函数
// ============================================================================

/**
 * 检测指定哈希是否为零哈希（用于新建/删除引用）
 */
function isZeroHash(hash: SHA1): boolean {
  return hash === ZERO_HASH;
}

// ============================================================================
// Push 编排
// ============================================================================

/**
 * 执行 push 操作
 *
 * 将本地对象推送到远程 Git 仓库。
 *
 * @param store - 本地对象存储
 * @param refs - 本地引用存储
 * @param url - 远程仓库 URL（如 "https://github.com/user/repo"）
 * @param options - 可选配置
 * @returns push 操作结果
 *
 * @example
 * ```ts
 * const result = await push(repo.objects, repo.refs, "https://github.com/user/repo");
 * console.log(`Pushed ${result.objectCount} objects`);
 * ```
 */
export async function push(
  store: ObjectStore,
  refs: RefStore,
  url: string,
  options?: PushOptions,
): Promise<PushResult> {
  const client = createSmartHttpClient(url, {
    token: options?.token,
    headers: options?.headers,
  });

  // 1. 获取远程 receive-pack ref 广告
  const adv = await client.getReceivePackRefs();

  // 2. 解析 refspec
  const refSpecStr = options?.refSpecs ?? [DEFAULT_REFSPEC];
  const parsedSpecs = refSpecStr.map(parseRefSpec);

  // 对 force 选项的处理：如果 PushOptions.force 为 true，将所有 force 标志设置为 true
  const effectiveSpecs: ParsedRefSpec[] = options?.force
    ? parsedSpecs.map((s) => ({ ...s, force: true }))
    : parsedSpecs;

  // 3. 获取本地 refs 和远程 refs
  const localRefs = getLocalRefs(refs);
  const remoteRefs = remoteRefsToMap(adv.refs);

  // 4. 确定要推送的引用
  const pushRefs = determinePushRefs(localRefs, remoteRefs, effectiveSpecs);

  if (pushRefs.length === 0) {
    return {
      refUpdates: [],
      objectCount: 0,
      progress: [],
    };
  }

  // 5. 收集需要发送的对象
  //    需要推送的对象 = 从推送 refs 可达的对象 - 从远程已有 refs 可达的对象
  //    删除操作（localHash === null）跳过对象收集
  const localRoots = pushRefs
    .filter((r): r is PushRefItem & { localHash: SHA1 } => r.localHash !== null)
    .map((r) => r.localHash);
  // 本地可达性使用 throw 模式：遇到缺失对象立即报错
  const reachableLocal = collectReachable(store, localRoots, "throw");

  // 收集远程已有 refs 的可达对象（用于排除已存在的对象）
  // 此处使用 skip 模式：远程对象在本地缺失是正常情况
  const remoteRoots: SHA1[] = [];
  for (const [, hash] of remoteRefs) {
    remoteRoots.push(hash);
  }
  const reachableRemote = collectReachable(store, remoteRoots);

  // 计算差集
  const objectsToSend: SHA1[] = [];
  for (const hash of reachableLocal) {
    if (!reachableRemote.has(hash)) {
      objectsToSend.push(hash);
    }
  }

  // 6. 构建 packfile
  //    此时 objectsToSend 中的对象已由遍历验证过存在性，无需额外容错
  const packWriter = createPackWriter();
  for (const hash of objectsToSend) {
    const obj = store.read(hash);
    packWriter.addObject(obj);
  }
  const packfile = packWriter.build();

  // 7. 确定可用能力
  const caps = extractCapabilities(adv.capabilities);

  // 8. 构造 receive-pack 命令
  //    删除操作时 newHash 用零哈希表示
  const commands = pushRefs.map((r) => ({
    oldHash: r.remoteHash ?? (ZERO_HASH as SHA1),
    newHash: r.localHash ?? (ZERO_HASH as SHA1),
    refName: r.remoteRef,
  }));

  // 9. 构建请求
  const body = buildReceivePackRequest(commands, packfile, caps);

  // 10. 发送请求
  let progress: string[];
  let refUpdates: PushRefUpdate[];
  try {
    const result = await client.postReceivePack(body);
    progress = result.progress;
    refUpdates = result.refUpdates;
  } catch (err: unknown) {
    if (err instanceof ReceivePackResultError) {
      throw new PushError(`Remote server rejected the push: ${err.message}`);
    }
    throw err;
  }

  // 11. 将服务端返回的 report-status 与我们的推送引用关联，补充 refName/oldHash/newHash 信息
  const pushRefMap = new Map<string, PushRefItem>();
  for (const item of pushRefs) {
    pushRefMap.set(item.remoteRef, item);
  }

  const enrichedUpdates: PushRefUpdate[] = refUpdates.map((u) => {
    const matched = pushRefMap.get(u.refName);
    return {
      refName: u.refName,
      oldHash: matched?.remoteHash ?? null,
      newHash: matched?.localHash ?? null,
      success: u.success,
      error: u.error,
      forced: matched?.force ?? false,
    };
  });

  return {
    refUpdates: enrichedUpdates,
    objectCount: packWriter.objectCount,
    progress,
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从服务端 capabilities 中提取客户端可用的能力列表
 */
function extractCapabilities(serverCaps: Record<string, string | true>): string[] {
  const supported = new Set<string>(DEFAULT_CAPABILITIES);
  return Object.keys(serverCaps).filter((cap) => supported.has(cap));
}
