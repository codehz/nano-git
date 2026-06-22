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
import { HEADS_PREFIX, HEAD_REF, resolveRefHash, resolveSymbolicRef } from "../refs/index.ts";
import { isAncestor, collectReachable, peelTagChain } from "./object-graph.ts";
import { buildReceivePackRequest } from "./receive-pack-request.ts";
import { ReceivePackResultError } from "./receive-pack-result.ts";
import { parseRefSpec } from "./ref-plan.ts";
import { createSmartHttpClient } from "./smart-http.ts";

import type { SHA1 } from "../core/types.ts";
import type { ObjectStore } from "../odb/types.ts";
import type { RefStore } from "../refs/types.ts";
import type { ParsedRefSpec } from "./ref-plan.ts";
import type { PushOptions, PushResult, PushRefUpdate } from "./types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * Push 操作错误
 *
 * 当服务端部分或全部拒绝更新时抛出。
 * 即使抛出异常，`refUpdates` 属性仍会保留服务端返回的所有 ref 状态
 * （包含成功和失败的），以便调用方在部分成功场景下做出相应处理。
 */
export class PushError extends GitError {
  /** 服务端返回的所有 ref 更新结果（包含成功和失败） */
  refUpdates?: PushRefUpdate[];
  /** 服务端返回的进度消息 */
  progress?: string[];

  constructor(message: string, extra?: { refUpdates?: PushRefUpdate[]; progress?: string[] }) {
    super(`Push error: ${message}`);
    this.name = "PushError";
    if (extra) {
      this.refUpdates = extra.refUpdates;
      this.progress = extra.progress;
    }
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

    // 相同哈希（已是最新，no-op）总是安全
    if (item.localHash === item.remoteHash) {
      continue;
    }

    // Git 语义：refs/tags/* 不允许任何替换（即使是 fast-forward），必须显式 force
    if (item.remoteRef.startsWith("refs/tags/")) {
      throw new PushError(
        `Tag update rejected for "${item.remoteRef}": ` +
          `tag already exists, cannot replace without force (--force or +refspec).`,
      );
    }

    // Non-commit 对象检查：fast-forward 概念只适用于 commit 对象。
    // 如果 remote 或 local 解引用后不是 commit，必须使用 --force。
    const peeledRemote = peelTagChain(store, item.remoteHash, shallowBoundaries);
    const peeledLocal = peelTagChain(store, item.localHash, shallowBoundaries);

    if (store.exists(peeledRemote)) {
      const remoteObj = store.read(peeledRemote);
      if (remoteObj.type !== "commit") {
        throw new PushError(
          `Update rejected for "${item.remoteRef}": ` +
            `remote object is a ${remoteObj.type}, expected commit. ` +
            `Use --force or +refspec to override.`,
        );
      }
    }

    if (store.exists(peeledLocal)) {
      const localObj = store.read(peeledLocal);
      if (localObj.type !== "commit") {
        throw new PushError(
          `Update rejected for "${item.remoteRef}": ` +
            `local object is a ${localObj.type}, expected commit. ` +
            `Use --force or +refspec to override.`,
        );
      }
    }

    // 构建逐 ref 的独立边界集，仅包含本 ref 的远端 tip。
    // 注意：此处不传递全局 shallowBoundaries 给 isAncestor，因为
    // isAncestor 的"遇到边界即放行"语义对 push fast-forward 预检来说
    // 过于宽松——任意缺失祖先只要落在边界集合中就会被错误放行。
    // 只有本 ref 自身的 remoteHash 才是合法的缺失边界（服务端持有它，
    // 且它在祖先链上就等于找到 peeledOld）。
    const refBoundaries = new Set<SHA1>();
    if (item.remoteHash) {
      refBoundaries.add(item.remoteHash);
    }

    if (!isAncestor(store, item.remoteHash, item.localHash, refBoundaries)) {
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
  // 跟踪整组 refspec 是否包含未匹配到任何本地 ref 的 wildcard
  let hasUnmatchedWildcard = false;

  for (const spec of specs) {
    if (spec.isWildcard) {
      // 通配符 refspec：匹配所有以 srcPattern 开头的本地引用
      let matchedAny = false;
      for (const [localRef, localHash] of localRefs) {
        if (!localRef.startsWith(spec.srcPattern)) continue;
        matchedAny = true;

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
      if (!matchedAny) {
        hasUnmatchedWildcard = true;
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

  // 整次 push 未产生任何推送项且原因是有 wildcard 未匹配到本地 ref
  if (items.length === 0 && hasUnmatchedWildcard) {
    throw new PushError("src refspec does not match any local ref");
  }

  return items;
}

/**
 * 获取本地 refs 的哈希映射
 *
 * 扫描 refs/ 下所有命名空间的引用，确保 push refspec 中
 * 任意来源引用（如 refs/remotes/、refs/notes/ 等）都能被正确检测到。
 */
function getLocalRefs(refs: RefStore): Map<string, SHA1> {
  const map = new Map<string, SHA1>();

  // 所有 refs/ 下的引用
  for (const refName of refs.listAll()) {
    const content = refs.read(refName);
    if (content && /^[0-9a-f]{40}$/.test(content)) {
      try {
        map.set(refName, sha1(content));
      } catch {
        // 忽略无效哈希
      }
    }
  }

  // HEAD 可能指向 refs/ 外的引用（如 "HEAD" 自身），
  // 解析失败（循环/损坏）不影响其他 ref 的推送
  try {
    const hash = resolveRefHash(refs, HEAD_REF);
    if (hash) {
      map.set(HEAD_REF, hash);
    }
  } catch {
    // 忽略解析失败（如循环引用）
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

/**
 * 合并 shallow 边界与各推送项的远端当前 tip，供预检与本地可达性遍历使用
 */
function mergePushBoundaries(
  shallowSet: Set<SHA1> | undefined,
  pushRefs: PushRefItem[],
): Set<SHA1> | undefined {
  const remoteTips = pushRefs
    .map((item) => item.remoteHash)
    .filter((hash): hash is SHA1 => hash !== null);

  if (!shallowSet && remoteTips.length === 0) {
    return undefined;
  }

  const merged = new Set<SHA1>(shallowSet);
  for (const hash of remoteTips) {
    merged.add(hash);
  }
  return merged;
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

  // 推送边界：shallow 边界 + 各 ref 远端当前 tip（本地可无对象，服务端仍持有）
  // 注意：此合并边界仅用于对象收集（collectReachable），不可用于 fast-forward 预检。
  const pushBoundaries = mergePushBoundaries(shallowSet, pushRefs);

  // 6. non-fast-forward 预检
  //    未设 force 的更新如果不是 fast-forward 则立即报错。
  //    此处的边界只传 shallowSet（不含所有 ref 的统一远端 tip 合并集），
  //    逐 ref 的远端 tip 由 checkFastForward 内部按 item 独立加入边界，
  //    避免 A ref 的缺失 parent 被 B ref 的远端 tip 错误放行。
  checkFastForward(store, pushRefs, shallowSet);

  // 7. 收集需要发送的对象
  //    需要推送的对象 = 从推送 refs 可达的对象 - 从远程已有 refs 可达的对象
  //    删除操作（localHash === null）跳过对象收集
  const localRoots = pushRefs
    .filter((r): r is PushRefItem & { localHash: SHA1 } => r.localHash !== null)
    .map((r) => r.localHash);
  // 本地可达性：使用 "skip-commit-parents" 让缺失的 commit parent 不阻断遍历，
  // 但 tree/blob/tag 等非 commit-parent 边的缺失仍会抛出 PushError，防止本地损坏被静默掩盖
  let reachableLocal: Set<SHA1>;
  try {
    reachableLocal = collectReachable(store, localRoots, "skip-commit-parents", pushBoundaries);
  } catch (err: unknown) {
    throw new PushError(err instanceof Error ? err.message : String(err));
  }

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

  // 8c. 校验 delete-refs capability
  //     删除操作（localHash === null）要求服务端支持 delete-refs。
  //     服务端未广告时在发送请求前立即报错，避免徒劳的协议往返。
  const hasDeleteCommand = pushRefs.some((r) => r.localHash === null);
  if (hasDeleteCommand && !caps.includes("delete-refs")) {
    throw new PushError(
      "Remote server does not advertise 'delete-refs' capability, " +
        "but the push includes a delete ref operation.",
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

  // 11b-2. 校验服务端返回的 ref 名称集合与发送命令完全一致
  //        即使数量相同，服务端仍可能返回不匹配的 ref 名称（协议异常）。
  //        例如发送 refs/heads/main 却收到 ok refs/heads/other，
  //        这会将错误 ref 名当作成功返回给调用方，使协议异常被静默掩盖。
  const commandRefNames = new Set(commands.map((c) => c.refName));
  const updateRefNames = new Set(refUpdates.map((u) => u.refName));
  const unexpectedRefs = [...updateRefNames].filter((n) => !commandRefNames.has(n));
  const missingRefs = [...commandRefNames].filter((n) => !updateRefNames.has(n));
  if (unexpectedRefs.length > 0 || missingRefs.length > 0) {
    const parts: string[] = [];
    if (unexpectedRefs.length > 0) {
      parts.push(`unexpected ref(s): ${unexpectedRefs.join(", ")}`);
    }
    if (missingRefs.length > 0) {
      parts.push(`missing ref(s): ${missingRefs.join(", ")}`);
    }
    throw new PushError(`Server returned mismatched ref status: ${parts.join("; ")}`);
  }

  // 11c. 将服务端返回的 report-status 与我们的推送引用关联，补充 oldHash/newHash/forced 信息
  //     必须在后续任何数据返回（包括错误时的 refUpdates）之前完成富化，
  //     以确保调用方在部分成功场景下能拿到完整的 ref 状态。
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

  // 11d. 检查是否有被服务端拒绝的更新
  //      非 atomic 场景下服务端可能部分接受部分拒绝，此时 PushError
  //      会携带完整的 refUpdates（含成功项）和 progress，供调用方决策。
  const rejectedUpdates = enrichedUpdates.filter((u) => !u.success);
  if (rejectedUpdates.length > 0) {
    const details = rejectedUpdates
      .map((u) => `${u.refName}: ${u.error ?? "unknown error"}`)
      .join("; ");
    throw new PushError(`Remote server rejected the push: ${details}`, {
      refUpdates: enrichedUpdates,
      progress,
    });
  }

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
