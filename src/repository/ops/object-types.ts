/**
 * 仓库对象操作类型定义
 */

import type { DiffEntry } from "../../diff.ts";
import type { GitAuthor, GitObject, SHA1, TreeEntry } from "../../types/index.ts";
import type { TreeSnapshotEntry } from "../tree/tree-diff.ts";
import type { TreePatchOp, TreePatchResult } from "../tree/tree-patch.ts";

/**
 * 仓库对象核心操作
 */
export interface RepositoryObjectOperations {
  /**
   * 计算数据的 blob 哈希（不写入存储）
   *
   * 等价于 `git hash-object --stdin`
   */
  hashObject(data: Buffer): SHA1;

  /**
   * 将数据作为 blob 写入对象存储
   *
   * 等价于 `git hash-object -w --stdin`
   */
  writeBlob(data: Buffer): SHA1;

  /**
   * 读取对象
   *
   * 等价于 `git cat-file -p <hash>`
   */
  catFile(hash: SHA1): GitObject;

  /**
   * 获取对象类型
   *
   * 等价于 `git cat-file -t <hash>`
   */
  catFileType(hash: SHA1): string;

  /**
   * 列出仓库当前可见的所有对象哈希
   *
   * 返回值同时包含 loose objects 和 packed objects。
   */
  listObjects(): SHA1[];

  /**
   * 从 tree 条目列表创建 tree 对象
   */
  createTree(entries: TreeEntry[]): SHA1;

  /**
   * 创建 commit 对象
   *
   * 等价于 `git commit-tree <tree> -p <parent> -m <message>`
   */
  createCommit(
    tree: SHA1,
    parents: SHA1[],
    message: string,
    author: GitAuthor,
    committer?: GitAuthor,
  ): SHA1;

  /**
   * 对已有 tree 执行增量 patch 操作
   *
   * 无需完整重构整棵树，只更新受影响的路径。
   * 支持增（upsert）、删（delete）、改（upsert）文件及符号链接，
   * 自动创建缺失的中间目录。
   *
   * @param rootHash - 根 tree 哈希
   * @param ops - patch 操作列表（同路径多次操作最后一个生效）
   * @returns patch 结果
   *
   * @example
   * ```ts
   * const result = repo.patchTree(rootHash, [
   *   { op: "upsert", path: "src/main.ts", mode: "100644", hash: blobHash },
   *   { op: "delete", path: "old.ts" },
   * ]);
   * ```
   */
  patchTree(rootHash: SHA1, ops: TreePatchOp[]): TreePatchResult;

  /**
   * 读取 tree 的完整快照
   *
   * 返回展平后的路径视图，并包含目录条目自身。
   */
  readTreeSnapshot(rootHash: SHA1): TreeSnapshotEntry[];

  /**
   * 比较两个 tree 的快照差异
   *
   * 当前只提供路径最终状态上的 create / remove / update 语义。
   */
  diffTrees(previousTree: SHA1, currentTree: SHA1): DiffEntry[];
}

/**
 * 文件系统对象操作扩展
 */
export interface RepositoryFsObjectOperations {
  /**
   * 将文件作为 blob 写入对象存储
   *
   * 等价于 `git hash-object -w <file>`
   */
  writeBlobFile(filePath: string): SHA1;

  /**
   * 将目录递归写入 tree 对象
   *
   * 等价于 `git write-tree`（但基于指定目录而非暂存区）
   */
  writeTree(dirPath: string): SHA1;
}
