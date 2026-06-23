/**
 * Tree 遍历工具
 *
 * 提供展平的 tree 视图和递归遍历能力，
 * 补充 patchTree 只有增量修改能力的不足。
 */

import type { SHA1, TreeEntry } from "../core/types.ts";
import type { ObjectStore } from "../odb/index.ts";

/**
 * 带完整路径的 tree 条目
 */
export interface TreeEntryWithPath extends TreeEntry {
  /** 相对于根 tree 的完整路径 */
  readonly path: string;
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
export function readTree(objects: ObjectStore, rootHash: SHA1): TreeEntryWithPath[] {
  const result: TreeEntryWithPath[] = [];
  walkTreeRecursive(objects, rootHash, "", result);
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
  objects: ObjectStore,
  rootHash: SHA1,
  visit: (entry: TreeEntryWithPath) => void,
): void {
  walkTreeRecursive(objects, rootHash, "", undefined, visit);
}

function walkTreeRecursive(
  objects: ObjectStore,
  treeHash: SHA1,
  prefix: string,
  result?: TreeEntryWithPath[],
  visit?: (entry: TreeEntryWithPath) => void,
): void {
  const obj = objects.read(treeHash);
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

    if (result) {
      result.push(entryWithPath);
    }
    if (visit) {
      visit(entryWithPath);
    }

    // 递归子树
    if (entry.mode === "40000") {
      walkTreeRecursive(objects, entry.hash, path, result, visit);
    }
  }
}
