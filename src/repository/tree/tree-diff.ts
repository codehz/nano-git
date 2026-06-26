/**
 * Tree snapshot 与 diff 工具
 *
 * 将 Git tree 视为不可变目录快照，
 * 提供“读取完整快照”和“比较两个快照”的一等能力。
 *
 * 当前语义只关注路径最终状态，
 * 不尝试推断 move / copy 来源。
 */

import { readObject } from "../../objects/raw.ts";

import type { SHA1, TreeEntry } from "../../core/types.ts";
import type { ObjectDatabase } from "../../odb/types.ts";

/**
 * tree 快照中的对象种类
 */
export type TreeSnapshotKind = "blob" | "tree" | "symlink";

/**
 * tree 快照中的对象描述
 */
export interface TreeSnapshotObject {
  /** 条目种类 */
  readonly kind: TreeSnapshotKind;
  /** Git 文件模式 */
  readonly mode: "100644" | "100755" | "040000" | "120000";
  /** 对象哈希 */
  readonly hash: SHA1;
}

/**
 * tree 快照条目
 */
export interface TreeSnapshotEntry {
  /** 相对根 tree 的完整路径 */
  readonly path: string;
  /** 当前对象 */
  readonly object: TreeSnapshotObject;
}

/**
 * 同路径更新的变化维度
 */
export interface TreeDiffChanges {
  /** 条目种类是否变化 */
  readonly kindChanged: boolean;
  /** mode 是否变化 */
  readonly modeChanged: boolean;
  /** 内容哈希是否变化 */
  readonly contentChanged: boolean;
}

/**
 * tree diff 条目
 */
export type TreeDiffEntry =
  | {
      /** 新建路径 */
      readonly kind: "create";
      /** 当前路径 */
      readonly path: string;
      /** 当前对象 */
      readonly current: TreeSnapshotObject;
    }
  | {
      /** 删除路径 */
      readonly kind: "remove";
      /** 当前路径 */
      readonly path: string;
      /** 删除前对象 */
      readonly previous: TreeSnapshotObject;
    }
  | {
      /** 同路径更新 */
      readonly kind: "update";
      /** 当前路径 */
      readonly path: string;
      /** 更新前对象 */
      readonly previous: TreeSnapshotObject;
      /** 更新后对象 */
      readonly current: TreeSnapshotObject;
      /** 变化维度 */
      readonly changes: TreeDiffChanges;
    };

/**
 * 带完整路径的 tree 条目
 */
export interface TreeEntryWithPath extends TreeEntry {
  /** 相对于根 tree 的完整路径 */
  readonly path: string;
}

/**
 * 读取 tree 的完整快照
 *
 * 会包含目录条目自身，适合直接做 tree-to-tree 对比。
 *
 * @example
 * ```ts
 * const snapshot = readTreeSnapshot(repo.objects, treeHash);
 * expect(snapshot.map((entry) => entry.path)).toEqual(["src", "src/main.ts"]);
 * ```
 */
export function readTreeSnapshot(objects: ObjectDatabase, rootHash: SHA1): TreeSnapshotEntry[] {
  const result: TreeSnapshotEntry[] = [];
  walkTreeRecursive(objects, rootHash, "", (entry) => {
    result.push({
      path: entry.path,
      object: treeEntryToSnapshotObject(entry),
    });
  });
  return result;
}

/**
 * 比较两个 tree 快照
 *
 * 当前只做同路径对比：
 * - 新路径 => create
 * - 消失路径 => remove
 * - 同路径对象不同 => update
 *
 * 不分析 move / copy 来源。
 *
 * @example
 * ```ts
 * const diff = diffTrees(repo.objects, oldTree, newTree);
 * expect(diff.map((entry) => entry.path)).toEqual(["README.md"]);
 * ```
 */
export function diffTrees(
  objects: ObjectDatabase,
  previousTree: SHA1,
  currentTree: SHA1,
): TreeDiffEntry[] {
  const previousSnapshot = readTreeSnapshot(objects, previousTree);
  const currentSnapshot = readTreeSnapshot(objects, currentTree);

  const previousByPath = new Map(previousSnapshot.map((entry) => [entry.path, entry.object]));
  const currentByPath = new Map(currentSnapshot.map((entry) => [entry.path, entry.object]));
  const allPaths = new Set<string>([...previousByPath.keys(), ...currentByPath.keys()]);
  const diff: TreeDiffEntry[] = [];

  for (const path of Array.from(allPaths).sort((left, right) => left.localeCompare(right))) {
    const previous = previousByPath.get(path) ?? null;
    const current = currentByPath.get(path) ?? null;

    if (previous === null && current !== null) {
      diff.push({ kind: "create", path, current });
      continue;
    }

    if (previous !== null && current === null) {
      diff.push({ kind: "remove", path, previous });
      continue;
    }

    if (previous !== null && current !== null && !isSameObject(previous, current)) {
      diff.push({
        kind: "update",
        path,
        previous,
        current,
        changes: {
          kindChanged: previous.kind !== current.kind,
          modeChanged: previous.mode !== current.mode,
          contentChanged: previous.hash !== current.hash,
        },
      });
    }
  }

  return diff;
}

/**
 * 递归遍历 tree，返回所有条目的展平列表（深度优先，按目录排序）
 *
 * @param objects - 对象存储
 * @param rootHash - 根 tree 哈希
 * @returns 带完整路径的条目列表
 *
 * @example
 * ```ts
 * const files = readTree(objects, treeHash);
 * for (const entry of files) {
 *   console.log(entry.path, entry.mode, entry.hash);
 * }
 * ```
 */
export function readTree(objects: ObjectDatabase, rootHash: SHA1): TreeEntryWithPath[] {
  const result: TreeEntryWithPath[] = [];
  walkTreeRecursive(objects, rootHash, "", (entry) => {
    result.push(entry);
  });
  return result;
}

/**
 * 递归遍历 tree，对每个条目调用回调函数
 *
 * 深度优先，先遍历子目录（所有条目按目录分组输出）。
 *
 * @param objects - 对象存储
 * @param rootHash - 根 tree 哈希
 * @param visit - 对每个条目的回调
 *
 * @example
 * ```ts
 * walkTree(objects, treeHash, (entry) => {
 *   console.log(entry.path);
 * });
 * ```
 */
export function walkTree(
  objects: ObjectDatabase,
  rootHash: SHA1,
  visit: (entry: TreeEntryWithPath) => void,
): void {
  walkTreeRecursive(objects, rootHash, "", visit);
}

function walkTreeRecursive(
  objects: ObjectDatabase,
  treeHash: SHA1,
  prefix: string,
  visit: (entry: TreeEntryWithPath) => void,
): void {
  const obj = readObject(objects, treeHash);
  if (obj.type !== "tree") {
    throw new Error(`Expected tree object, got '${obj.type}' for hash '${treeHash}'`);
  }

  for (const entry of obj.entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const entryWithPath: TreeEntryWithPath = {
      mode: entry.mode,
      name: entry.name,
      hash: entry.hash,
      path,
    };

    visit(entryWithPath);

    if (entry.mode === "040000") {
      walkTreeRecursive(objects, entry.hash, path, visit);
    }
  }
}

function treeEntryToSnapshotObject(entry: TreeEntry): TreeSnapshotObject {
  return {
    kind: modeToTreeSnapshotKind(entry.mode),
    mode: assertSnapshotMode(entry.mode),
    hash: entry.hash,
  };
}

function modeToTreeSnapshotKind(mode: string): TreeSnapshotKind {
  if (mode === "040000") {
    return "tree";
  }
  if (mode === "120000") {
    return "symlink";
  }
  if (mode === "100644" || mode === "100755") {
    return "blob";
  }
  throw new Error(`Unsupported tree entry mode for snapshot diff: ${mode}`);
}

function assertSnapshotMode(mode: string): TreeSnapshotObject["mode"] {
  if (mode === "100644" || mode === "100755" || mode === "040000" || mode === "120000") {
    return mode;
  }
  throw new Error(`Unsupported tree entry mode for snapshot diff: ${mode}`);
}

function isSameObject(previous: TreeSnapshotObject, current: TreeSnapshotObject): boolean {
  return (
    previous.kind === current.kind &&
    previous.mode === current.mode &&
    previous.hash === current.hash
  );
}
