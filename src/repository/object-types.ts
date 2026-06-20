/**
 * 仓库对象操作类型定义
 */

import type { GitAuthor, GitObject, SHA1, TreeEntry } from "../core/types.ts";

/**
 * 仓库对象相关操作
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
   * 将文件作为 blob 写入对象存储
   *
   * 等价于 `git hash-object -w <file>`
   */
  writeBlobFile(filePath: string): SHA1;

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
   * 将目录递归写入 tree 对象
   *
   * 等价于 `git write-tree`（但基于指定目录而非暂存区）
   */
  writeTree(dirPath: string): SHA1;

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
}
