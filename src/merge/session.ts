/**
 * 交互式 merge 会话：plan → resolve → finalize
 *
 * - 对冲突路径逐条决议（ours / theirs / base / custom）
 * - 允许覆盖 autoEntries 中的自动决议
 * - finalize 时写入 ODB 并返回最终 tree
 */

import { MergeError, UnresolvedConflictsError } from "../errors.ts";
import { writeObject } from "../objects/raw.ts";
import { buildTreeFromMergedEntries } from "./build-tree.ts";

import type { ObjectDatabase } from "../odb/types.ts";
import type {
  MergeConflict,
  MergeDecision,
  MergeFinalizeResult,
  MergePathDecision,
  MergePlan,
  MergeSession,
  MergeSide,
  MergedPathEntry,
} from "./types.ts";

/** 单条路径的最终决议 */
type PathResolution =
  | { readonly action: "take"; readonly entry: MergedPathEntry }
  | { readonly action: "delete" };

/**
 * 基于 MergePlan 创建交互式会话
 *
 * @param objects - 可写对象库（finalize / custom content 需要）
 * @param plan - `planTreeMerge` / `planCommitMerge` 产出的计划
 * @returns 会话对象
 *
 * @example
 * ```ts
 * const session = createMergeSession(repo.objects, plan);
 * for (const c of session.listConflicts()) {
 *   session.resolve(c.path, { take: "ours" });
 * }
 * const { tree } = session.finalize();
 * ```
 */
export function createMergeSession(objects: ObjectDatabase, plan: MergePlan): MergeSession {
  const resolutions = new Map<string, PathResolution>();

  const conflictByPath = new Map(plan.conflicts.map((c) => [c.path, c]));
  const autoByPath = new Map(plan.autoEntries.map((e) => [e.path, e]));

  function listConflicts(): readonly MergeConflict[] {
    return plan.conflicts.filter((c) => !resolutions.has(c.path));
  }

  function isComplete(): boolean {
    return listConflicts().length === 0;
  }

  function resolve(path: string, decision: MergeDecision): void {
    const conflict = conflictByPath.get(path);
    const auto = autoByPath.get(path);

    if (conflict === undefined && auto === undefined) {
      throw new MergeError(`Cannot resolve '${path}': not a conflict or auto-merged path`, {
        path,
      });
    }

    const resolution = decisionToResolution(path, decision, conflict, auto, objects);
    resolutions.set(path, resolution);
  }

  function resolveMany(decisions: readonly MergePathDecision[]): void {
    for (const item of decisions) {
      resolve(item.path, item.decision);
    }
  }

  function unresolve(path: string): void {
    resolutions.delete(path);
  }

  function finalize(): MergeFinalizeResult {
    const unresolved = listConflicts();
    if (unresolved.length > 0) {
      throw new UnresolvedConflictsError(
        `Cannot finalize merge: ${unresolved.length} unresolved conflict(s)`,
        { paths: unresolved.map((c) => c.path) },
      );
    }

    // 已有现成结果 tree 且无覆盖决议 → 直接返回
    if (plan.resultTree !== null && resolutions.size === 0) {
      return { tree: plan.resultTree, writtenTrees: [] };
    }

    // 合成路径表：auto + 决议（决议覆盖同路径 auto；delete 移除）
    const entryMap = new Map<string, MergedPathEntry>();
    for (const entry of plan.autoEntries) {
      entryMap.set(entry.path, entry);
    }

    for (const [path, resolution] of resolutions) {
      if (resolution.action === "delete") {
        entryMap.delete(path);
      } else {
        entryMap.set(path, resolution.entry);
      }
    }

    // 若合成结果恰好等于某侧完整 tree，且没有任何「展开条目」需要组装——
    // 仍走 buildTree，保证覆盖 auto 后语义一致。
    const entries = [...entryMap.values()].sort((left, right) => {
      if (left.path < right.path) return -1;
      if (left.path > right.path) return 1;
      return 0;
    });

    return buildTreeFromMergedEntries(objects, entries);
  }

  return {
    plan,
    listConflicts,
    resolve,
    resolveMany,
    unresolve,
    isComplete,
    finalize,
  };
}

// ============================================================================
// 决议转换
// ============================================================================

function decisionToResolution(
  path: string,
  decision: MergeDecision,
  conflict: MergeConflict | undefined,
  auto: MergedPathEntry | undefined,
  objects: ObjectDatabase,
): PathResolution {
  if (decision.take === "custom") {
    if ("content" in decision) {
      const hash = writeObject(objects, { type: "blob", content: decision.content });
      return {
        action: "take",
        entry: {
          path,
          mode: decision.mode,
          hash,
          kind: modeToKindForCustom(decision.mode),
        },
      };
    }
    return {
      action: "take",
      entry: {
        path,
        mode: decision.mode,
        hash: decision.hash,
        kind: modeToKindForCustom(decision.mode),
      },
    };
  }

  // take: ours | theirs | base
  if (conflict !== undefined) {
    const side = pickSide(decision.take, conflict.base, conflict.ours, conflict.theirs);
    if (side === null) {
      // 该侧不存在 → 删除路径
      return { action: "delete" };
    }
    return {
      action: "take",
      entry: { path, mode: side.mode, hash: side.hash, kind: side.kind },
    };
  }

  // 覆盖 auto 路径：ours/theirs/base 语义需从 plan 树侧读取不现实；
  // 对 auto 路径仅允许 take 为对应当前 auto 的「确认」或 custom。
  // 约定：对 auto 路径 take "ours"|"theirs"|"base" 均表示保留 auto 结果
  // （调用方若要改用 custom）。若需要按侧覆盖，应使用 custom。
  //
  // 更合理：auto 覆盖时 take ours/theirs/base 非法，必须 custom？
  // 计划写的是 take ours/theirs/base/custom —— 对冲突路径有意义。
  // 对 auto 覆盖：保留 auto 用 unresolve；改用 custom。
  if (auto !== undefined) {
    throw new MergeError(
      `Overriding auto-merged path '${path}' requires a custom decision ` +
        `({ take: "custom", mode, hash|content }); use unresolve() to drop an override`,
      { path },
    );
  }

  throw new MergeError(`Cannot resolve '${path}'`, { path });
}

function pickSide(
  take: "ours" | "theirs" | "base",
  base: MergeSide | null,
  ours: MergeSide | null,
  theirs: MergeSide | null,
): MergeSide | null {
  switch (take) {
    case "ours":
      return ours;
    case "theirs":
      return theirs;
    case "base":
      if (base === null) {
        throw new MergeError("Cannot take base: base side is null for this conflict");
      }
      return base;
  }
}

function modeToKindForCustom(mode: string): MergedPathEntry["kind"] {
  if (mode === "040000") return "tree";
  if (mode === "120000") return "symlink";
  if (mode === "100644" || mode === "100755") return "blob";
  throw new MergeError(`Unsupported mode in custom merge decision: ${mode}`);
}
