/**
 * 仓库对象操作类型定义
 */

import type { GitAuthor, GitObject, SHA1, TreeEntry } from "../../core/types.ts";
import type { TreePatchOp, TreePatchResult } from "../tree/tree-patch.ts";

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
   * 查询远端对象信息（协议 v2 object-info）
   *
   * 批量查询远端对象的元数据（如 size），无需下载对象内容。
   * 仅在远端支持 Git Wire 协议 v2 时可用。
   *
   * @param url - 远端仓库 URL
   * @param oids - 要查询的 OID 列表
   * @param token - 可选认证 token
   * @returns 对象信息列表（含 size 等元数据）
   *
   * @example
   * ```ts
   * const result = await repo.fetchObjectInfo("https://github.com/user/repo", [
   *   "95d09f2b10159347eece71399a7e2e907ea3df4f",
   * ]);
   * console.log(result.objects[0]?.size); // 文件大小
   * ```
   */
  fetchObjectInfo(
    url: string,
    oids: string[],
    token?: string,
  ): Promise<import("../../transport/client/upload-pack/object-info.ts").ObjectInfoQueryResult>;
}
