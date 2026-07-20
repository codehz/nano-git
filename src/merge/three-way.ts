/**
 * 路径级三方 tree 合并（plan 阶段，纯计算不写 ODB）
 *
 * 规则基于路径 identity，不做 rename 检测。
 * 子树在 hash 相等时短路；冲突路径展开到具体文件以便交互决议。
 *
 * 目录删除 vs 对侧修改：将删除侧视为空 tree 递归，使内部路径呈现 modify-delete。
 */

import { MergeError } from "../errors.ts";
import { readObject } from "../objects/raw.ts";
import { sha1 } from "../types/index.ts";

import type { ObjectSource } from "../odb/types.ts";
import type { SHA1, TreeEntry } from "../types/index.ts";
import type {
  MergeConflict,
  MergeConflictReason,
  MergedPathEntry,
  MergeObjectKind,
  MergePlan,
  MergePlanStatus,
  MergeSide,
  PlanTreeMergeInput,
} from "./types.ts";

/** Git 空 tree 的规范哈希（tree 0） */
export const EMPTY_TREE_HASH = sha1("4b825dc642cb6eb9a060e54bf8d69288fbee4904");

// ============================================================================
// 内部结果
// ============================================================================

interface MergeTreesResult {
  readonly autoEntries: MergedPathEntry[];
  readonly conflicts: MergeConflict[];
  /**
   * 若本子树完整复用某一已有 tree hash 则为该 hash；
   * 需要重新组装时为 null。
   */
  readonly reusedTree: SHA1 | null;
}

// ============================================================================
// mode / kind 工具
// ============================================================================

function modeToKind(mode: string): MergeObjectKind {
  if (mode === "040000") {
    return "tree";
  }
  if (mode === "120000") {
    return "symlink";
  }
  if (mode === "100644" || mode === "100755") {
    return "blob";
  }
  throw new MergeError(`Unsupported tree entry mode for merge: ${mode}`);
}

function entryToSide(entry: TreeEntry): MergeSide {
  return {
    mode: entry.mode,
    hash: entry.hash,
    kind: modeToKind(entry.mode),
  };
}

function sideEqual(a: MergeSide | null, b: MergeSide | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.mode === b.mode && a.hash === b.hash;
}

function joinPath(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

// ============================================================================
// 读取 tree
// ============================================================================

function readTreeEntryMap(source: ObjectSource, treeHash: SHA1 | null): Map<string, TreeEntry> {
  const map = new Map<string, TreeEntry>();
  if (treeHash === null) {
    return map;
  }

  const obj = readObject(source, treeHash);
  if (obj.type !== "tree") {
    throw new MergeError(`Expected tree object for merge, got '${obj.type}'`, {
      hash: treeHash,
    });
  }

  for (const entry of obj.entries) {
    // 预先校验 mode，避免深层才抛出
    modeToKind(entry.mode);
    map.set(entry.name, entry);
  }
  return map;
}

// ============================================================================
// 整树复用
// ============================================================================

function takeWholeTree(treeHash: SHA1 | null, prefix: string): MergeTreesResult {
  if (treeHash === null) {
    return { autoEntries: [], conflicts: [], reusedTree: null };
  }

  if (prefix === "") {
    return { autoEntries: [], conflicts: [], reusedTree: treeHash };
  }

  return {
    autoEntries: [
      {
        path: prefix,
        mode: "040000",
        hash: treeHash,
        kind: "tree",
      },
    ],
    conflicts: [],
    reusedTree: treeHash,
  };
}

function takeSideAsEntry(path: string, side: MergeSide): MergeTreesResult {
  return {
    autoEntries: [
      {
        path,
        mode: side.mode,
        hash: side.hash,
        kind: side.kind,
      },
    ],
    conflicts: [],
    reusedTree: side.kind === "tree" ? side.hash : null,
  };
}

function conflictResult(conflict: MergeConflict): MergeTreesResult {
  return { autoEntries: [], conflicts: [conflict], reusedTree: null };
}

function makeConflict(
  path: string,
  reason: MergeConflictReason,
  base: MergeSide | null,
  ours: MergeSide | null,
  theirs: MergeSide | null,
): MergeConflict {
  return { path, reason, base, ours, theirs };
}

// ============================================================================
// 递归三方合并
// ============================================================================

/**
 * 递归合并三个 tree。
 *
 * `null` 表示该侧无此目录（空 tree），用于目录删除场景。
 */
function mergeTrees(
  source: ObjectSource,
  baseTree: SHA1 | null,
  oursTree: SHA1 | null,
  theirsTree: SHA1 | null,
  prefix: string,
): MergeTreesResult {
  // 整树短路
  if (oursTree === theirsTree) {
    return takeWholeTree(oursTree, prefix);
  }
  if (baseTree === oursTree) {
    return takeWholeTree(theirsTree, prefix);
  }
  if (baseTree === theirsTree) {
    return takeWholeTree(oursTree, prefix);
  }

  const baseMap = readTreeEntryMap(source, baseTree);
  const oursMap = readTreeEntryMap(source, oursTree);
  const theirsMap = readTreeEntryMap(source, theirsTree);

  const names = new Set<string>([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);
  const sortedNames = [...names].sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });

  const autoEntries: MergedPathEntry[] = [];
  const conflicts: MergeConflict[] = [];

  for (const name of sortedNames) {
    const childPath = joinPath(prefix, name);
    const baseEntry = baseMap.get(name) ?? null;
    const oursEntry = oursMap.get(name) ?? null;
    const theirsEntry = theirsMap.get(name) ?? null;

    const child = mergeEntry(source, baseEntry, oursEntry, theirsEntry, childPath);
    autoEntries.push(...child.autoEntries);
    conflicts.push(...child.conflicts);
  }

  return { autoEntries, conflicts, reusedTree: null };
}

/**
 * 合并同名单条 entry
 */
function mergeEntry(
  source: ObjectSource,
  baseEntry: TreeEntry | null,
  oursEntry: TreeEntry | null,
  theirsEntry: TreeEntry | null,
  path: string,
): MergeTreesResult {
  const base = baseEntry ? entryToSide(baseEntry) : null;
  const ours = oursEntry ? entryToSide(oursEntry) : null;
  const theirs = theirsEntry ? entryToSide(theirsEntry) : null;

  // 两侧均缺失 → 删除（相对 parent 无条目）
  if (ours === null && theirs === null) {
    return { autoEntries: [], conflicts: [], reusedTree: null };
  }

  // 两侧结果相同
  if (sideEqual(ours, theirs) && ours !== null) {
    return takeSideAsEntry(path, ours);
  }

  // 仅 ours
  if (ours !== null && theirs === null) {
    if (base === null) {
      return takeSideAsEntry(path, ours);
    }
    if (sideEqual(base, ours)) {
      // 对侧删除，我方未改 → 删除
      return { autoEntries: [], conflicts: [], reusedTree: null };
    }
    // 目录：展开为内部 modify-delete
    if (base.kind === "tree" && ours.kind === "tree") {
      return mergeTrees(source, base.hash, ours.hash, null, path);
    }
    return conflictResult(makeConflict(path, "modify-delete", base, ours, null));
  }

  // 仅 theirs
  if (ours === null && theirs !== null) {
    if (base === null) {
      return takeSideAsEntry(path, theirs);
    }
    if (sideEqual(base, theirs)) {
      return { autoEntries: [], conflicts: [], reusedTree: null };
    }
    if (base.kind === "tree" && theirs.kind === "tree") {
      return mergeTrees(source, base.hash, null, theirs.hash, path);
    }
    return conflictResult(makeConflict(path, "modify-delete", base, null, theirs));
  }

  // 两侧均存在且不同（上方已处理 equal）
  // ours / theirs 在此分支均非 null
  const oursSide = ours!;
  const theirsSide = theirs!;

  // 类型冲突（blob/tree/symlink 不一致）
  if (oursSide.kind !== theirsSide.kind) {
    return conflictResult(makeConflict(path, "type-change", base, oursSide, theirsSide));
  }

  // 双方均为目录 → 递归
  if (oursSide.kind === "tree" && theirsSide.kind === "tree") {
    const baseHash =
      base !== null && base.kind === "tree"
        ? base.hash
        : base === null
          ? null
          : // base 是文件/链接而两侧是目录：把 base 视为空目录参与递归
            null;

    // 若 base 存在但类型不是 tree，属于相对 base 的类型变化；两侧仍同为 tree 则递归合并内容
    const sub = mergeTrees(source, baseHash, oursSide.hash, theirsSide.hash, path);
    if (sub.conflicts.length === 0 && sub.reusedTree !== null) {
      return takeWholeTree(sub.reusedTree, path);
    }
    return sub;
  }

  // 双方均为 blob 或 symlink
  if (base === null) {
    // 两侧同时新增但内容/mode 不同
    if (oursSide.hash === theirsSide.hash && oursSide.mode !== theirsSide.mode) {
      return conflictResult(makeConflict(path, "mode-conflict", null, oursSide, theirsSide));
    }
    return conflictResult(makeConflict(path, "add-add", null, oursSide, theirsSide));
  }

  // base 类型与两侧不同（例如 base 是 tree，两侧变成文件）
  if (base.kind !== oursSide.kind) {
    // 仅一侧从 base 改类型？此处两侧 kind 相同且都不同于 base
    // 若内容也相同，可视为共同类型变更；不同则 both-modified / type-change
    if (sideEqual(oursSide, theirsSide)) {
      return takeSideAsEntry(path, oursSide);
    }
    return conflictResult(makeConflict(path, "type-change", base, oursSide, theirsSide));
  }

  // 仅 ours 相对 base 变化
  if (sideEqual(base, theirsSide)) {
    return takeSideAsEntry(path, oursSide);
  }
  // 仅 theirs 相对 base 变化
  if (sideEqual(base, oursSide)) {
    return takeSideAsEntry(path, theirsSide);
  }

  // 两侧都改了：同 hash 不同 mode → mode-conflict；否则 both-modified
  if (oursSide.hash === theirsSide.hash && oursSide.mode !== theirsSide.mode) {
    return conflictResult(makeConflict(path, "mode-conflict", base, oursSide, theirsSide));
  }

  // 同内容同 mode 已在 sideEqual 处理；此处 hash 或 mode 不同
  // 若 hash 相同 mode 也相同不会到这
  // 一侧只改 mode、另一侧只改内容？仍算 both-modified
  return conflictResult(makeConflict(path, "both-modified", base, oursSide, theirsSide));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * 对三个 tree 做路径级三方合并，产出 `MergePlan`（不写 ODB）
 *
 * @param source - 对象源
 * @param input - base / ours / theirs tree 哈希
 * @returns 合并计划
 *
 * @example
 * ```ts
 * const plan = planTreeMerge(repo.objects, {
 *   baseTree,
 *   oursTree,
 *   theirsTree,
 * });
 * if (plan.status === "conflicted") {
 *   console.log(plan.conflicts.map((c) => c.path));
 * }
 * ```
 */
export function planTreeMerge(source: ObjectSource, input: PlanTreeMergeInput): MergePlan {
  const { baseTree, oursTree, theirsTree } = input;

  // 根级状态短路（与 mergeTrees 一致，但赋予 FF / up-to-date 语义）
  if (oursTree === theirsTree) {
    return {
      status: "already-up-to-date",
      resultTree: oursTree,
      baseTree,
      oursTree,
      theirsTree,
      autoEntries: [],
      conflicts: [],
      bases: [],
    };
  }

  if (baseTree === theirsTree) {
    // 仅 ours 有变更
    return {
      status: "already-up-to-date",
      resultTree: oursTree,
      baseTree,
      oursTree,
      theirsTree,
      autoEntries: [],
      conflicts: [],
      bases: [],
    };
  }

  if (baseTree === oursTree) {
    // 仅 theirs 有变更 → fast-forward
    return {
      status: "fast-forward",
      resultTree: theirsTree,
      baseTree,
      oursTree,
      theirsTree,
      autoEntries: [],
      conflicts: [],
      bases: [],
    };
  }

  const merged = mergeTrees(source, baseTree, oursTree, theirsTree, "");

  let status: MergePlanStatus;
  let resultTree: SHA1 | null = null;

  if (merged.conflicts.length > 0) {
    status = "conflicted";
  } else {
    status = "clean";
    resultTree = merged.reusedTree;
  }

  return {
    status,
    resultTree,
    baseTree,
    oursTree,
    theirsTree,
    autoEntries: merged.autoEntries,
    conflicts: merged.conflicts,
    bases: [],
  };
}
