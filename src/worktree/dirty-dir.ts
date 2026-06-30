/**
 * Virtual Worktree 脏目录摘要
 *
 * 当前阶段维护：
 * - 哪些目录当前被标记为 dirty
 * - 该目录下哪些直接子项受影响
 * - 该目录子树里累计有多少直接脏项与更深层脏项
 * - 该目录当前 tree hash 是否仍可复用
 */

import { VIRTUAL_ROOT_PATH, parentPath } from "./path.ts";

import type { SHA1 } from "../core/types.ts";

/**
 * 目录摘要中的 hash 状态
 */
export type DirtyDirHashState = "stale" | "materialized";

/**
 * 脏目录摘要
 */
export interface DirtyDirSummary {
  /** 目录路径，根目录为 "" */
  readonly path: string;
  /** 当前目录是否脏 */
  readonly isDirty: boolean;
  /** 当前目录下受影响的直接子项数量 */
  readonly dirtyEntryCount: number;
  /** 当前目录更深层受影响子项数量 */
  readonly dirtyDescendantCount: number;
  /** 当前目录下受影响的直接子项名称 */
  readonly affectedNames: readonly string[];
  /** 当前物化 tree hash；未计算时为 null */
  readonly currentTreeHash: SHA1 | null;
  /** 当前 tree hash 的可信状态 */
  readonly hashState: DirtyDirHashState;
}

/**
 * 计算某路径对应的祖先目录链，包含根目录。
 *
 * @example
 * ```ts
 * expect(ancestorDirectoryPathsFor("a/b.txt")).toEqual(["", "a"]);
 * ```
 */
export function ancestorDirectoryPathsFor(path: string): readonly string[] {
  const out = new Set<string>([VIRTUAL_ROOT_PATH]);
  let cursor = parentPath(path);
  while (cursor !== null) {
    out.add(cursor);
    cursor = parentPath(cursor);
  }
  return Array.from(out).sort((left, right) => left.localeCompare(right));
}

/**
 * 计算某路径沿祖先目录链受影响的直接子项。
 *
 * @example
 * ```ts
 * expect(affectedDirectoryEntriesForPath("a/b/c.txt")).toEqual([
 *   { dirPath: "", affectedName: "a" },
 *   { dirPath: "a", affectedName: "b" },
 *   { dirPath: "a/b", affectedName: "c.txt" },
 * ]);
 * ```
 */
export function affectedDirectoryEntriesForPath(
  path: string,
): readonly { readonly dirPath: string; readonly affectedName: string }[] {
  const segments = path.split("/");
  const out: Array<{ readonly dirPath: string; readonly affectedName: string }> = [];

  for (let index = 0; index < segments.length; index += 1) {
    const affectedName = segments[index];
    if (affectedName === undefined) {
      continue;
    }
    const dirPath = segments.slice(0, index).join("/");
    out.push({ dirPath, affectedName });
  }

  return out;
}

/**
 * 创建脏目录摘要记录
 */
export function createDirtyDirSummary(
  path: string,
  affectedNames: readonly string[] = [],
): DirtyDirSummary {
  const names = [...new Set(affectedNames)].sort((left, right) => left.localeCompare(right));
  return {
    path,
    isDirty: true,
    dirtyEntryCount: names.length,
    dirtyDescendantCount: 0,
    affectedNames: names,
    currentTreeHash: null,
    hashState: "stale",
  };
}

/**
 * 合并单个受影响子项到目录摘要。
 */
export function mergeDirtyDirSummary(
  current: DirtyDirSummary | null,
  path: string,
  affectedName: string,
): DirtyDirSummary {
  const names = new Set(current?.affectedNames ?? []);
  const didAddName = !names.has(affectedName);
  names.add(affectedName);
  return {
    path,
    isDirty: true,
    dirtyEntryCount: didAddName
      ? (current?.dirtyEntryCount ?? 0) + 1
      : (current?.dirtyEntryCount ?? names.size),
    dirtyDescendantCount: current?.dirtyDescendantCount ?? 0,
    affectedNames: Array.from(names).sort((left, right) => left.localeCompare(right)),
    currentTreeHash: null,
    hashState: "stale",
  };
}

/**
 * 增加目录摘要的更深层脏项计数。
 */
export function incrementDirtyDirDescendantCount(
  current: DirtyDirSummary | null,
  path: string,
  delta = 1,
): DirtyDirSummary {
  return {
    path,
    isDirty: true,
    dirtyEntryCount: current?.dirtyEntryCount ?? 0,
    dirtyDescendantCount: (current?.dirtyDescendantCount ?? 0) + delta,
    affectedNames: [...(current?.affectedNames ?? [])].sort((left, right) =>
      left.localeCompare(right),
    ),
    currentTreeHash: null,
    hashState: "stale",
  };
}

/**
 * 将目录摘要标记为已物化 tree hash。
 */
export function materializeDirtyDirSummary(
  current: DirtyDirSummary | null,
  path: string,
  treeHash: SHA1,
): DirtyDirSummary {
  return {
    path,
    isDirty: true,
    dirtyEntryCount: current?.dirtyEntryCount ?? 0,
    dirtyDescendantCount: current?.dirtyDescendantCount ?? 0,
    affectedNames: [...(current?.affectedNames ?? [])].sort((left, right) =>
      left.localeCompare(right),
    ),
    currentTreeHash: treeHash,
    hashState: "materialized",
  };
}
