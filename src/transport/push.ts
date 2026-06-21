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

import { GitError } from "../core/errors.ts";
import { sha1 } from "../core/types.ts";
import { createPackWriter } from "../odb/pack/pack-writer.ts";
import {
  HEADS_PREFIX,
  HEAD_REF,
  TAGS_PREFIX,
  resolveRefHash,
  resolveSymbolicRef,
} from "../refs/index.ts";
import { parseRefSpec } from "./fetch.ts";
import { buildReceivePackRequest } from "./receive-pack-request.ts";
import { ReceivePackResultError } from "./receive-pack-result.ts";
import { createSmartHttpClient } from "./smart-http.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectStore } from "../odb/types.ts";
import type { RefStore } from "../refs/types.ts";
import type { ParsedRefSpec } from "./fetch.ts";
import type { PushOptions, PushResult, PushRefUpdate } from "./types.ts";

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
/** collectReachable 遇到缺失对象时的策略 */
export type CollectReachableMissing = "throw" | "skip" | "skip-commit-parents";

function throwIfMissingObject(
  objects: ObjectStore,
  hash: SHA1,
  missing: CollectReachableMissing,
  viaCommitParent: boolean,
  shallowBoundaries?: Set<SHA1>,
): void {
  // 如果缺失的 commit parent 在已知 shallow 边界集合中，按正常边界处理
  if (viaCommitParent && shallowBoundaries?.has(hash)) {
    return;
  }

  const shouldThrow =
    missing === "throw" || (missing === "skip-commit-parents" && !viaCommitParent);

  if (shouldThrow) {
    throw new PushError(
      `Object ${hash} is missing from the local store. ` +
        `The local repository may be incomplete or corrupted. ` +
        `Try fetching or running a repair before pushing.`,
    );
  }
}

/**
 * 从指定哈希出发，递归收集所有可达对象哈希
 *
 * @param objects - 对象存储
 * @param hash - 起始对象哈希
 * @param reachable - 用于收集结果的可达集合
 * @param missing - 遇到缺失对象时的行为：
 *   - `"skip"`（默认）：静默跳过，用于远程排除计算
 *   - `"throw"`：任意缺失均抛出 PushError
 *   - `"skip-commit-parents"`：仅沿 commit parent 边缺失时跳过（shallow push）
 * @param viaCommitParent - 当前边是否来自 commit 的 parent 引用
 */
function collectReachableFrom(
  objects: ObjectStore,
  hash: SHA1,
  reachable: Set<SHA1>,
  missing: CollectReachableMissing = "skip",
  shallowBoundaries?: Set<SHA1>,
  viaCommitParent = false,
): void {
  if (reachable.has(hash)) {
    return;
  }

  if (!objects.exists(hash)) {
    throwIfMissingObject(objects, hash, missing, viaCommitParent, shallowBoundaries);
    return;
  }

  reachable.add(hash);
  const obj = objects.read(hash);

  switch (obj.type) {
    case "blob":
      return;
    case "tree":
      for (const entry of obj.entries) {
        collectReachableFrom(objects, entry.hash, reachable, missing, shallowBoundaries, false);
      }
      return;
    case "commit":
      collectReachableFrom(objects, obj.tree, reachable, missing, shallowBoundaries, false);
      for (const parent of obj.parents) {
        collectReachableFrom(objects, parent, reachable, missing, shallowBoundaries, true);
      }
      return;
    case "tag":
      collectReachableFrom(objects, obj.object, reachable, missing, shallowBoundaries, false);
      return;
  }
}

/**
 * 从多个起始点收集所有可达对象哈希
 *
 * @param missing - 遇到缺失对象时的行为，透传给 collectReachableFrom
 * @param shallowBoundaries - 已知 shallow 边界集合（可选）
 *
 * @internal 导出仅用于测试
 */
export function collectReachable(
  objects: ObjectStore,
  roots: SHA1[],
  missing: CollectReachableMissing = "skip",
  shallowBoundaries?: Set<SHA1>,
): Set<SHA1> {
  const reachable = new Set<SHA1>();
  for (const hash of roots) {
    collectReachableFrom(objects, hash, reachable, missing, shallowBoundaries, false);
  }
  return reachable;
}

// ============================================================================
// Fast-forward 预检
// ============================================================================

/**
 * 检查 oldHash 是否为 newHash 的祖先 commit（或二者相等）
 *
 * 从 newHash 出发沿 parent 链回溯，若能找到 oldHash 则返回 true。
 * 用于 non-fast-forward 预检：当 force 未设置时，若返回 false 则应拒绝推送。
 *
 * @param store - 对象存储
 * @param oldHash - 远程 ref 当前指向的 commit
 * @param newHash - 本地要推送的目标 commit
 * @returns oldHash 是否为 newHash 的祖先
 *
 * @internal 导出仅用于测试
 */
export function isAncestor(
  store: ObjectStore,
  oldHash: SHA1,
  newHash: SHA1,
  shallowBoundaries?: Set<SHA1>,
): boolean {
  // 相同哈希 trivially 是 fast-forward
  if (oldHash === newHash) {
    return true;
  }

  // 如果起点 commit 不存在，无法判断
  if (!store.exists(newHash)) {
    return false;
  }

  // 将可达性遍历限制在 commit 链上
  const visited = new Set<SHA1>();
  const queue: SHA1[] = [newHash];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current === oldHash) {
      return true;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    // 对象缺失的处理：先检查是否为已知 shallow boundary
    if (!store.exists(current)) {
      // 如果缺失哈希在 shallow 边界集合中，按正常 shallow 边界处理
      // 此时无法确定 oldHash 是否在更上游，假定为 fast-forward 让服务端做最终判定
      if (shallowBoundaries?.has(current)) {
        return true;
      }
      // 不在 shallow 集合中且对象缺失，视为本地损坏，停止回溯
      return false;
    }

    try {
      const obj = store.read(current);

      if (obj.type !== "commit") {
        // 遍历中遇到非 commit 对象（tree/blob/tag），不继续沿此路径回溯
        continue;
      }

      for (const parent of obj.parents) {
        if (!visited.has(parent)) {
          queue.push(parent);
        }
      }
    } catch {
      // 读取异常视为此路径不可达，继续遍历其他路径
      continue;
    }
  }

  return false;
}

/**
 * 预检所有推送项是否为 fast-forward，不通过的（且未设 force）立即报错
 *
 * @param store - 对象存储
 * @param items - 推送引用项列表
 * @param shallowBoundaries - 已知 shallow 边界集合（可选）
 *   提供后，isAncestor 会优先判断缺失 parent 是否为已知 shallow boundary，
 *   避免在 shallow 仓库中将正常边界缺失误判为损坏。
 *
 * @throws PushError 如果存在 non-fast-forward 更新且未设 force
 *
 * @internal 导出仅用于测试
 */
export function checkFastForward(
  store: ObjectStore,
  items: PushRefItem[],
  shallowBoundaries?: Set<SHA1>,
): void {
  for (const item of items) {
    // 删除操作（newHash === null）或新建操作（remoteHash === null）总是安全
    if (item.localHash === null || item.remoteHash === null) {
      continue;
    }

    // force 跳过预检
    if (item.force) {
      continue;
    }

    if (!isAncestor(store, item.remoteHash, item.localHash, shallowBoundaries)) {
      const shortRemote = item.remoteHash.slice(0, 8);
      const shortLocal = item.localHash.slice(0, 8);
      throw new PushError(
        `Non-fast-forward update rejected for "${item.remoteRef}": ` +
          `remote ${shortRemote} is not an ancestor of local ${shortLocal}. ` +
          `Use force (--force or +refspec) to override.`,
      );
    }
  }
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
  const seen = new Set<string>();

  for (const spec of specs) {
    if (spec.isWildcard) {
      // 通配符 refspec：匹配所有以 srcPattern 开头的本地引用
      for (const [localRef, localHash] of localRefs) {
        if (!localRef.startsWith(spec.srcPattern)) continue;

        const suffix = localRef.slice(spec.srcPattern.length);
        const remoteRef = `${spec.dstPattern}${suffix}`;

        // 重叠 refspec 去重：同一 remoteRef 只保留首个
        if (seen.has(remoteRef)) continue;
        seen.add(remoteRef);

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
      const remoteRef = spec.dstPattern;

      // 重叠 refspec 去重
      if (seen.has(remoteRef)) continue;
      seen.add(remoteRef);

      const remoteHash = remoteRefs.get(remoteRef) ?? null;
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

      // 重叠 refspec 去重
      if (seen.has(remoteRef)) continue;
      seen.add(remoteRef);

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

  // 遍历 refs/tags/
  for (const refName of refs.listRaw(TAGS_PREFIX)) {
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
// Push 编排
// ============================================================================

/**
 * 生成默认 refspec
 *
 * 等价于 `git push <url>` 的默认行为：将当前分支推送到远端同名分支。
 * - HEAD 指向 `refs/heads/<name>` 时，返回 `"HEAD:refs/heads/<name>"`
 * - HEAD 为 detached 状态时，抛出 PushError
 *
 * @param refs - 本地引用存储
 * @returns 形如 `"HEAD:refs/heads/<branch>"` 的 refspec
 * @throws PushError 当 HEAD 处于 detached 状态时
 */
function resolveDefaultRefSpec(refs: RefStore): string {
  const target = resolveSymbolicRef(refs, HEAD_REF);
  if (target === null) {
    throw new PushError(
      "HEAD is detached — cannot determine current branch. " +
        'Specify a refspec explicitly (e.g. { refSpecs: ["HEAD:refs/heads/main"] })',
    );
  }
  if (!target.startsWith(HEADS_PREFIX)) {
    throw new PushError(
      `HEAD points to "${target}" which is not a branch. ` +
        "Specify a refspec explicitly when pushing from a non-branch ref.",
    );
  }
  return `HEAD:${target}`;
}

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
  const client =
    options?.transport ??
    createSmartHttpClient(url, {
      token: options?.token,
      headers: options?.headers,
    });

  // 1. 获取远程 receive-pack ref 广告
  const adv = await client.getReceivePackRefs();

  // 2. 解析 refspec（未提供时按 HEAD 指向的分支动态生成）
  const refSpecStr = options?.refSpecs ?? [resolveDefaultRefSpec(refs)];
  const parsedSpecs = refSpecStr.map(parseRefSpec);

  // 对 force 选项的处理：如果 PushOptions.force 为 true，将所有 force 标志设置为 true
  const effectiveSpecs: ParsedRefSpec[] = options?.force
    ? parsedSpecs.map((s) => ({ ...s, force: true }))
    : parsedSpecs;

  // 3. 获取 shallow 边界集合（用于更精确的缺失对象判断）
  const shallowSet: Set<SHA1> | undefined = options?.shallowBoundaries
    ? new Set(options.shallowBoundaries)
    : undefined;

  // 4. 获取本地 refs 和远程 refs
  const localRefs = getLocalRefs(refs);
  const remoteRefs = remoteRefsToMap(adv.refs);

  // 5. 确定要推送的引用
  const pushRefs = determinePushRefs(localRefs, remoteRefs, effectiveSpecs);

  if (pushRefs.length === 0) {
    return {
      refUpdates: [],
      objectCount: 0,
      progress: [],
    };
  }

  // 6. non-fast-forward 预检
  //    未设 force 的更新如果不是 fast-forward 则立即报错
  //    传入 shallowSet 让 isAncestor 能精确判断 shallow boundary，
  //    避免将已知的 shallow 边界缺失误判为损坏。
  checkFastForward(store, pushRefs, shallowSet);

  // 7. 收集需要发送的对象
  //    需要推送的对象 = 从推送 refs 可达的对象 - 从远程已有 refs 可达的对象
  //    删除操作（localHash === null）跳过对象收集
  const localRoots = pushRefs
    .filter((r): r is PushRefItem & { localHash: SHA1 } => r.localHash !== null)
    .map((r) => r.localHash);
  // 本地可达性：使用 "skip-commit-parents" 让缺失的 commit parent 不阻断遍历，
  // 但 tree/blob/tag 等非 commit-parent 边的缺失仍会抛出 PushError，防止本地损坏被静默掩盖
  const reachableLocal = collectReachable(store, localRoots, "skip-commit-parents", shallowSet);

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

  // 7. 构建 packfile（objectsToSend 已在本地可达性遍历中校验存在）
  const packWriter = createPackWriter();
  for (const hash of objectsToSend) {
    const obj = store.read(hash);
    packWriter.addObject(obj);
  }
  const packfile = packWriter.build();

  // 8. 确定可用能力
  const caps = extractCapabilities(adv.capabilities);

  // 8b. 校验 report-status capability
  //     push 完成后依赖 report-status 获取每条命令的执行结果，
  //     若服务端不支持此能力则无法可靠判断 push 是否成功，
  //     因此在发送请求前提前报错以避免不可恢复的半完成状态。
  if (!caps.includes("report-status")) {
    throw new PushError(
      "Remote server does not advertise 'report-status' capability. " +
        "This client requires report-status to reliably determine push results. " +
        "Please use a Git server that supports report-status.",
    );
  }

  // 9. 构造 receive-pack 命令
  //    删除操作时 newHash 用零哈希表示
  const commands = pushRefs.map((r) => ({
    oldHash: r.remoteHash ?? (ZERO_HASH as SHA1),
    newHash: r.localHash ?? (ZERO_HASH as SHA1),
    refName: r.remoteRef,
  }));

  // 10. 构建请求
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

  // 11. 防御性检查：发送了命令但收到空 refUpdates 属于协议异常
  //     （可能是下层解析错误被静默处理或服务端未按协议返回 report-status）
  if (commands.length > 0 && refUpdates.length === 0) {
    throw new PushError(
      "Server returned no status updates for the push commands. " +
        "This may indicate a protocol compatibility issue or a server-side parsing error.",
    );
  }

  // 11b. 校验服务端返回的状态行是否覆盖了所有已发送命令
  //      report-status 协议要求每条命令有对应的 ok/ng 行，
  //      缺少状态行说明服务端响应不完整或下层解析存在分片异常。
  if (commands.length !== refUpdates.length) {
    const receivedRefNames = new Set(refUpdates.map((u) => u.refName));
    const missingRefs = commands.filter((c) => !receivedRefNames.has(c.refName));
    throw new PushError(
      `Server returned incomplete status: expected ${commands.length} status line(s) ` +
        `but got ${refUpdates.length}. Missing status for: ${missingRefs.map((r) => r.refName).join(", ")}`,
    );
  }

  // 12. 将服务端返回的 report-status 与我们的推送引用关联，补充 refName/oldHash/newHash 信息
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
