/**
 * Import View 实现
 *
 * 提供远端 ref 视图的创建和操作功能，包括视图过滤、排除、合并和命名，
 * 以及路径前缀计算和命名空间目标解析。
 */

import { matchRefGlob } from "./import-glob.ts";

import type { RemoteRef } from "../transport/shared/types.ts";
import type { ImportView, NamedImportView } from "./import-session-types.ts";

// ============================================================================
// View 实现
// ============================================================================

/**
 * 创建 ImportView
 *
 * @param refs - 冻结的远端 ref 列表
 * @param label - 可选的视图标签
 * @returns ImportView 或 NamedImportView
 */
export function createImportView(
  refs: readonly RemoteRef[],
  label?: string,
): ImportView | NamedImportView {
  const frozenRefs = Object.freeze(refs.map((ref) => Object.freeze({ ...ref })));

  const view = {
    get refs(): readonly RemoteRef[] {
      return frozenRefs;
    },

    where(predicate: (ref: RemoteRef) => boolean): ImportView {
      return createImportView(frozenRefs.filter(predicate)) as ImportView;
    },

    exclude(pattern: string): ImportView {
      const filtered = frozenRefs.filter((ref) => !matchRefGlob(pattern, ref.name));
      return createImportView(filtered) as ImportView;
    },

    union(other: ImportView): ImportView {
      const seen = new Set<string>();
      const merged: RemoteRef[] = [];

      for (const ref of frozenRefs) {
        if (!seen.has(ref.name)) {
          seen.add(ref.name);
          merged.push(ref);
        }
      }
      for (const ref of other.refs) {
        if (!seen.has(ref.name)) {
          seen.add(ref.name);
          merged.push(ref);
        }
      }

      return createImportView(merged) as ImportView;
    },

    name(n: string): NamedImportView {
      return createImportView(frozenRefs, n) as NamedImportView;
    },

    get label(): string | undefined {
      return label;
    },
  };

  return view;
}

// ============================================================================
// 路径前缀工具
// ============================================================================

/**
 * 计算多个 ref 名称的最长公共路径前缀
 *
 * 结果保证以 `/` 结尾。单个 ref 时取其目录前缀。
 *
 * @param names - ref 名称列表
 * @returns 最长公共路径前缀（含末尾 /），如 "refs/heads/"
 *
 * @example
 * ```ts
 * longestCommonRefPrefix(["refs/heads/main", "refs/heads/develop"]); // "refs/heads/"
 * longestCommonRefPrefix(["refs/heads/main", "refs/tags/v1"]);       // "refs/"
 * ```
 */
export function longestCommonRefPrefix(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) {
    const lastSlash = names[0]!.lastIndexOf("/");
    return lastSlash >= 0 ? names[0]!.slice(0, lastSlash + 1) : "";
  }

  let prefix = names[0]!;
  for (let i = 1; i < names.length; i++) {
    while (names[i]!.indexOf(prefix) !== 0) {
      prefix = prefix.slice(0, -1);
      if (prefix === "") return "";
    }
  }

  const lastSlash = prefix.lastIndexOf("/");
  return lastSlash >= 0 ? prefix.slice(0, lastSlash + 1) : "";
}

/**
 * 判断两个远端 ref 是否表示同一条广告项
 *
 * @param left - 左侧 ref
 * @param right - 右侧 ref
 * @returns 是否相同
 */
export function isSameRemoteRef(left: RemoteRef, right: RemoteRef): boolean {
  return (
    left.name === right.name &&
    left.hash === right.hash &&
    left.peeled === right.peeled &&
    left.symrefTarget === right.symrefTarget
  );
}

/**
 * 解析命名空间物化：将 view 中的 refs 映射到目标命名空间
 *
 * 对每个 ref，计算其相对于 view 公共前缀的偏移，
 * 并用该偏移替换目标模式中的 `*`。
 *
 * @param refs - view 中的远端 refs
 * @param targetPattern - 目标模式，如 "refs/mirrors/upstream/*"
 * @returns 映射结果列表
 *
 * @example
 * ```ts
 * const targets = resolveNamespaceTargets(
 *   [refs/heads/main, refs/heads/develop],
 *   "refs/mirrors/upstream/*",
 * );
 * // => [{ localRef: "refs/mirrors/upstream/main" }, { localRef: "refs/mirrors/upstream/develop" }]
 * ```
 */
export function resolveNamespaceTargets(
  refs: readonly RemoteRef[],
  targetPattern: string,
): Array<{ remoteRef: RemoteRef; localRef: string }> {
  if (refs.length === 0) return [];

  if (!targetPattern.includes("*")) {
    return refs.map((r) => ({ remoteRef: r, localRef: targetPattern }));
  }

  const [beforeStar, afterStar] = targetPattern.split("*", 2);
  const commonPrefix = longestCommonRefPrefix(refs.map((r) => r.name));
  const after = afterStar ?? "";

  return refs.map((r) => {
    const suffix = r.name.slice(commonPrefix.length);
    return { remoteRef: r, localRef: `${beforeStar}${suffix}${after}` };
  });
}

/**
 * 截取命名空间目标模式的固定前缀
 *
 * @param targetPattern - 目标模式
 * @returns `*` 之前的固定前缀；无 `*` 时返回 null
 */
export function getNamespacePatternPrefix(targetPattern: string): string | null {
  const starIdx = targetPattern.indexOf("*");
  return starIdx >= 0 ? targetPattern.slice(0, starIdx) : null;
}
