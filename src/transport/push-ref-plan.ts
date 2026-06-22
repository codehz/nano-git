/**
 * Push 引用规划
 *
 * 处理"我要推哪些 ref"的问题：
 * - 解析 refspec 为本地→远程的映射
 * - 确定要推送的引用项列表
 * - 处理通配符、精确匹配、删除操作和去重
 *
 * @example
 * ```ts
 * import { determinePushRefs } from "./push-ref-plan.ts";
 * import { parseRefSpec } from "./ref-plan.ts";
 *
 * const localRefs = new Map([["refs/heads/main", "abc123..."]]);
 * const remoteRefs = new Map();
 * const specs = [parseRefSpec("refs/heads/main:refs/heads/main")];
 * const items = determinePushRefs(localRefs, remoteRefs, specs);
 * ```
 */

import { sha1 } from "../core/types.ts";
import { HEADS_PREFIX, HEAD_REF, resolveRefHash, resolveSymbolicRef } from "../refs/index.ts";
import { PushError } from "./push-error.ts";

import type { SHA1 } from "../core/types.ts";
import type { RefStore } from "../refs/types.ts";
import type { ParsedRefSpec } from "./ref-plan.ts";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 要推送的引用项
 */
export interface PushRefItem {
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

// ============================================================================
// 本地引用收集
// ============================================================================

/**
 * 获取本地 refs 的哈希映射
 *
 * 扫描 refs/ 下所有命名空间的引用，确保 push refspec 中
 * 任意来源引用（如 refs/remotes/、refs/notes/ 等）都能被正确检测到。
 */
export function getLocalRefs(refs: RefStore): Map<string, SHA1> {
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
export function remoteRefsToMap(refs: Array<{ name: string; hash: SHA1 }>): Map<string, SHA1> {
  const map = new Map<string, SHA1>();
  for (const ref of refs) {
    map.set(ref.name, ref.hash);
  }
  return map;
}

// ============================================================================
// 默认 refspec 解析
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
export function resolveDefaultRefSpec(refs: RefStore): string {
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

// ============================================================================
// 推送引用解析
// ============================================================================

/**
 * 解析 refspec 并确定要推送的引用列表
 *
 * 根据 refspec 匹配本地引用，并与远程引用对照。
 *
 * @param localRefs - 本地 ref → hash 映射
 * @param remoteRefs - 远程 ref → hash 映射
 * @param specs - 解析后的 refspec 列表
 * @returns 要推送的引用项列表
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
