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
 * import { parseRefSpec } from "../../protocol/refspec.ts";
 *
 * const localRefs = new Map([["refs/heads/main", "abc123..."]]);
 * const remoteRefs = new Map();
 * const specs = [parseRefSpec("refs/heads/main:refs/heads/main")];
 * const items = determinePushRefs(localRefs, remoteRefs, specs);
 * ```
 */

import { resolveSymbolicRef } from "../../../refs/resolve.ts";
import { HEADS_PREFIX } from "../../../types/refs.ts";
import { HEAD_REF } from "../../../types/refs.ts";
import { PushError } from "./push-error.ts";

import type { SHA1 } from "../../../types/index.ts";
import type { RefStore } from "../../../types/refs.ts";
import type { ParsedRefSpec } from "../../protocol/refspec.ts";

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
  const seen = new Map<string, string>();
  let hasUnmatchedWildcard = false;

  for (const spec of specs) {
    if (spec.isWildcard) {
      let matchedAny = false;
      for (const [localRef, localHash] of localRefs) {
        if (!localRef.startsWith(spec.srcPattern)) continue;
        matchedAny = true;

        const suffix = localRef.slice(spec.srcPattern.length);
        const remoteRef = `${spec.dstPattern}${suffix}`;

        // 冲突检测：同一 remoteRef 被多个规则映射
        const existingSpec = seen.get(remoteRef);
        if (existingSpec !== undefined) {
          throw new PushError(
            `Conflicting push refspec: "${spec.srcPattern}*:${spec.dstPattern}*" ` +
              `maps to "${remoteRef}" which is also mapped by "${existingSpec}".`,
          );
        }
        seen.set(remoteRef, `${spec.srcPattern}*:${spec.dstPattern}*`);

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
      const remoteRef = spec.dstPattern;

      const existingSpec = seen.get(remoteRef);
      if (existingSpec !== undefined) {
        throw new PushError(
          `Conflicting push refspec: ":${spec.dstPattern}" ` +
            `maps to "${remoteRef}" which is also mapped by "${existingSpec}".`,
        );
      }
      seen.set(remoteRef, `:${spec.dstPattern}`);

      const remoteHash = remoteRefs.get(remoteRef) ?? null;
      items.push({
        localRef: "",
        remoteRef: spec.dstPattern,
        localHash: null,
        remoteHash,
        force: spec.force,
      });
    } else {
      const remoteRef = spec.dstPattern;

      const existingSpec = seen.get(remoteRef);
      if (existingSpec !== undefined) {
        throw new PushError(
          `Conflicting push refspec: "${spec.srcPattern}:${spec.dstPattern}" ` +
            `maps to "${remoteRef}" which is also mapped by "${existingSpec}".`,
        );
      }
      seen.set(remoteRef, `${spec.srcPattern}:${spec.dstPattern}`);

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
