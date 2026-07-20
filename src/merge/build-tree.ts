/**
 * 将合并后的路径条目 bottom-up 写成 tree 对象
 *
 * - 支持压缩的目录级 entry（`kind: "tree"` 的中间路径）
 * - 支持展开的 `a/b/c.txt` 叶子路径
 * - 空目录不写入（Git 不存储空 tree 条目）
 * - 写出前按 `compareTreeEntries` 排序
 */

import { MergeError } from "../errors.ts";
import { writeObject } from "../objects/raw.ts";
import { compareTreeEntries } from "../objects/tree.ts";
import { sha1 } from "../types/index.ts";

import type { ObjectDatabase } from "../odb/types.ts";
import type { SHA1, TreeEntry } from "../types/index.ts";
import type { MergedPathEntry } from "./types.ts";

/** Git 空 tree 规范哈希 */
const EMPTY_TREE_HASH = sha1("4b825dc642cb6eb9a060e54bf8d69288fbee4904");

type ChildNode =
  | { readonly type: "entry"; readonly mode: string; readonly hash: SHA1 }
  | { readonly type: "dir"; readonly children: Map<string, ChildNode> };

/**
 * 从路径条目列表构建根 tree 并写入 ODB
 *
 * @param objects - 可写对象库
 * @param entries - 合并结果路径条目（不应含冲突路径）
 * @returns 根 tree 哈希与新写入的 tree 列表
 *
 * @example
 * ```ts
 * const { tree, writtenTrees } = buildTreeFromMergedEntries(repo.objects, [
 *   { path: "a.txt", mode: "100644", hash: blob, kind: "blob" },
 *   { path: "src", mode: "040000", hash: srcTree, kind: "tree" },
 * ]);
 * ```
 */
export function buildTreeFromMergedEntries(
  objects: ObjectDatabase,
  entries: readonly MergedPathEntry[],
): { tree: SHA1; writtenTrees: SHA1[] } {
  const root = new Map<string, ChildNode>();
  const writtenTrees: SHA1[] = [];

  for (const entry of entries) {
    if (entry.path === "") {
      throw new MergeError("Merged path entry path must not be empty");
    }
    insertEntry(root, entry.path.split("/"), entry);
  }

  const tree = writeDir(objects, root, writtenTrees);
  return { tree, writtenTrees };
}

/**
 * 确保空 tree 对象存在于 ODB 并返回其哈希
 *
 * @example
 * ```ts
 * const empty = ensureEmptyTree(repo.objects);
 * ```
 */
export function ensureEmptyTree(objects: ObjectDatabase): SHA1 {
  objects.ingest({
    hash: EMPTY_TREE_HASH,
    type: "tree",
    content: Buffer.alloc(0),
  });
  return EMPTY_TREE_HASH;
}

function insertEntry(dir: Map<string, ChildNode>, parts: string[], entry: MergedPathEntry): void {
  const name = parts[0];
  if (name === undefined || name === "") {
    throw new MergeError(`Invalid merged path: '${entry.path}'`, { path: entry.path });
  }

  if (parts.length === 1) {
    const existing = dir.get(name);
    if (existing?.type === "dir") {
      throw new MergeError(
        `Path conflict while building tree: '${entry.path}' is both a directory and a leaf`,
        { path: entry.path },
      );
    }
    dir.set(name, { type: "entry", mode: entry.mode, hash: entry.hash });
    return;
  }

  // 进入 / 创建子目录节点
  let child = dir.get(name);
  if (child === undefined) {
    const nested = new Map<string, ChildNode>();
    dir.set(name, { type: "dir", children: nested });
    insertEntry(nested, parts.slice(1), entry);
    return;
  }

  if (child.type === "entry") {
    throw new MergeError(
      `Path conflict while building tree: '${name}' is both a leaf and a directory ` +
        `(while inserting '${entry.path}')`,
      { path: entry.path },
    );
  }

  insertEntry(child.children, parts.slice(1), entry);
}

function writeDir(
  objects: ObjectDatabase,
  dir: Map<string, ChildNode>,
  writtenTrees: SHA1[],
): SHA1 {
  if (dir.size === 0) {
    return ensureEmptyTree(objects);
  }

  const treeEntries: TreeEntry[] = [];

  for (const [name, child] of dir) {
    if (child.type === "entry") {
      treeEntries.push({ mode: child.mode, name, hash: child.hash });
      continue;
    }

    // 子目录若为空则跳过（Git 不存空目录）
    if (child.children.size === 0) {
      continue;
    }
    const hash = writeDir(objects, child.children, writtenTrees);
    treeEntries.push({ mode: "040000", name, hash });
  }

  if (treeEntries.length === 0) {
    return ensureEmptyTree(objects);
  }

  treeEntries.sort(compareTreeEntries);
  const hash = writeObject(objects, { type: "tree", entries: treeEntries });
  writtenTrees.push(hash);
  return hash;
}
