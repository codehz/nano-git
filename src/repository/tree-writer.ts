/**
 * 工作目录到 tree 对象的写入工具
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ObjectStore } from "../store/index.ts";
import type { GitBlob, GitTree, TreeEntry, SHA1 } from "../types.ts";

/**
 * 递归将目录写入 tree 对象
 *
 * 遍历目录，为每个文件创建 blob，为每个子目录递归创建 tree，
 * 最后将所有条目组合成一个 tree 对象。
 *
 * @param store - 对象存储
 * @param dirPath - 要写入的目录路径
 * @returns 根 tree 对象哈希
 *
 * @example
 * ```ts
 * const hash = writeTreeRecursive(repo.objects, "/tmp/project");
 * console.log(hash);
 * ```
 */
export function writeTreeRecursive(store: ObjectStore, dirPath: string): SHA1 {
  const entries: TreeEntry[] = [];
  const items = readdirSync(dirPath).sort();

  for (const name of items) {
    if (name === ".git") {
      continue;
    }

    const fullPath = join(dirPath, name);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      const subtreeHash = writeTreeRecursive(store, fullPath);
      entries.push({
        mode: "40000",
        name,
        hash: subtreeHash,
      });
    } else if (stat.isFile()) {
      const content = readFileSync(fullPath);
      const blob: GitBlob = { type: "blob", content };
      const blobHash = store.write(blob);
      const mode = stat.mode & 0o111 ? "100755" : "100644";

      entries.push({
        mode,
        name,
        hash: blobHash,
      });
    }
  }

  const tree: GitTree = { type: "tree", entries };
  return store.write(tree);
}
