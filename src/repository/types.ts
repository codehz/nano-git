/**
 * Git 仓库高层 API 类型定义
 *
 * 提供类似 git 命令行的高层操作：
 * - init: 初始化仓库
 * - createRepository: 基于显式后端创建仓库
 * - hashObject: 计算文件哈希（可选写入）
 * - catFile: 读取对象内容
 * - writeTree: 将目录写入 tree 对象
 * - commitTree: 创建 commit 对象
 * - refs: 管理分支、标签和 HEAD
 *
 * 这些操作对应 git 的 plumbing 命令。
 */

import type { PackBuildResult } from "../odb/index.ts";
import type {
  RepositoryBackend,
  RepositoryGCOptions,
  RepositoryPackSupport,
  RepositoryRepackOptions,
} from "../backend/index.ts";
import type { RefStore } from "../refs/index.ts";
import type { ObjectStore } from "../odb/index.ts";
import type { GitObject, GitAuthor, TreeEntry, SHA1, ObjectType } from "../core/types.ts";

/**
 * Git 仓库接口
 */
export interface Repository {
  /** 底层仓库后端 */
  readonly backend: RepositoryBackend;

  /** Git 对象存储 */
  readonly objects: ObjectStore;

  /** Git 引用存储 */
  readonly refs: RefStore;

  /** Packfile 支持 */
  readonly packs: RepositoryPackSupport | null;

  /** .git 目录路径（内存仓库为 null） */
  readonly gitDir: string | null;

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

  /**
   * 将指定对象写入新的 packfile
   *
   * 未提供哈希列表时，默认打包仓库当前可见的全部对象。
   */
  writePack(hashes?: SHA1[]): PackBuildResult;

  /**
   * 重写仓库 pack 布局
   *
   * 默认行为：
   * - 打包当前可见的全部对象
   * - 删除旧 pack 文件
   * - 保留 loose objects
   */
  repack(options?: RepositoryRepackOptions): PackBuildResult;

  /**
   * 列出从 HEAD、所有分支和所有标签可达的对象
   */
  listReachableObjects(): SHA1[];

  /**
   * 执行基于可达对象的 gc
   *
   * 默认行为：
   * - 只保留从 HEAD、分支、标签可达的对象
   * - 删除旧 pack 文件
   * - 删除已打包的 loose objects
   */
  gc(options?: RepositoryGCOptions): PackBuildResult;
}
