/**
 * 仓库引用操作类型定义
 */

import type { GitAuthor, ObjectType, SHA1 } from "../core/types.ts";

/**
 * 仓库引用相关操作
 */
export interface RepositoryRefOperations {
  /**
   * 更新引用（ref）
   *
   * 等价于 `git update-ref <ref> <hash>`
   */
  updateRef(ref: string, hash: SHA1): void;

  /**
   * 读取引用（ref）
   *
   * 等价于 `git rev-parse <ref>`
   */
  readRef(ref: string): SHA1 | null;

  /**
   * 获取当前检出的分支名
   *
   * detached HEAD 时返回 null。
   */
  getCurrentBranch(): string | null;

  /**
   * 创建分支
   *
   * 未提供目标哈希时，默认基于当前 HEAD。
   */
  createBranch(name: string, hash?: SHA1): void;

  /**
   * 读取分支引用
   */
  readBranch(name: string): SHA1 | null;

  /**
   * 列出所有分支名
   */
  listBranches(): string[];

  /**
   * 删除分支
   */
  deleteBranch(name: string): void;

  /**
   * 创建轻量标签
   *
   * 未提供目标哈希时，默认指向当前 HEAD。
   */
  createTag(name: string, hash?: SHA1): void;

  /**
   * 创建附注标签（annotated tag）
   *
   * 返回 tag 对象自身的哈希。
   */
  createAnnotatedTag(
    name: string,
    target: SHA1,
    message: string,
    tagger: GitAuthor,
    objectType?: ObjectType,
  ): SHA1;

  /**
   * 读取标签引用
   */
  readTag(name: string): SHA1 | null;

  /**
   * 列出所有标签名
   */
  listTags(): string[];

  /**
   * 删除标签
   */
  deleteTag(name: string): void;
}
