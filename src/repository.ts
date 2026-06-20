/**
 * Git 仓库高层 API
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

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PackBuildResult } from "./pack/index.ts";
import type {
  RepositoryBackend,
  RepositoryPackSupport,
  RepositoryRepackOptions,
} from "./backend/index.ts";
import { createFileRepositoryBackend, createMemoryRepositoryBackend } from "./backend/index.ts";
import { hashObject } from "./hash.ts";
import {
  resolveRefHash,
  resolveSymbolicRef,
  resolveTargetHash,
  branchNameToRef,
  tagNameToRef,
  HEAD_REF,
  HEADS_PREFIX,
  TAGS_PREFIX,
} from "./refs/index.ts";
import type { RefStore } from "./refs/index.ts";
import type { ObjectStore } from "./store/index.ts";
import type {
  GitObject,
  GitBlob,
  GitTree,
  GitCommit,
  GitAuthor,
  TreeEntry,
  SHA1,
  ObjectType,
  GitTag,
} from "./types.ts";

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
}

/**
 * 初始化一个新的 Git 仓库
 *
 * 等价于 `git init`
 *
 * @param path - 仓库根目录路径
 *
 * @example
 * ```ts
 * const repo = initRepository("/tmp/demo");
 * console.log(repo.getCurrentBranch()); // => "main"
 * ```
 */
export function initRepository(path: string): Repository {
  const gitDir = join(path, ".git");

  // 创建 .git 目录结构
  mkdirSync(join(gitDir, "objects"), { recursive: true });
  mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
  mkdirSync(join(gitDir, "refs", "tags"), { recursive: true });

  // 写入 HEAD 文件
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");

  return createRepository(createFileRepositoryBackend(gitDir));
}

/**
 * 打开一个已有的 Git 仓库
 *
 * @param path - 仓库根目录路径
 *
 * @example
 * ```ts
 * const repo = openRepository("/path/to/repo");
 * console.log(repo.readRef("HEAD"));
 * ```
 */
export function openRepository(path: string): Repository {
  const gitDir = join(path, ".git");

  if (!existsSync(gitDir)) {
    throw new Error(`Not a git repository: ${path}`);
  }

  return createRepository(createFileRepositoryBackend(gitDir));
}

/**
 * 创建内存仓库（用于测试）
 *
 * @example
 * ```ts
 * const repo = createMemoryRepository();
 * repo.createBranch("main", repo.createTree([]));
 * ```
 */
export function createMemoryRepository(): Repository {
  return createRepository(createMemoryRepositoryBackend());
}

/**
 * 基于显式后端创建仓库实例
 *
 * Repository 不负责拼装 ObjectStore / RefStore，
 * 调用方需要显式提供统一的 RepositoryBackend。
 *
 * @example
 * ```ts
 * const backend = createMemoryRepositoryBackend();
 * const repo = createRepository(backend);
 * ```
 */
export function createRepository(backend: RepositoryBackend): Repository {
  const { objects, refs, packs, gitDir } = backend;

  function ensureRefDoesNotExist(ref: string, kind: "Branch" | "Tag", name: string): void {
    if (refs.readRaw(ref) !== null) {
      throw new Error(`${kind} already exists: ${name}`);
    }
  }

  function listShortRefs(prefix: string): string[] {
    return refs.listRaw(prefix).map((ref) => ref.slice(prefix.length));
  }

  return {
    backend,
    objects,
    refs,
    packs,
    gitDir,

    hashObject(data: Buffer): SHA1 {
      return hashObject("blob", data);
    },

    writeBlob(data: Buffer): SHA1 {
      const blob: GitBlob = { type: "blob", content: data };
      return objects.write(blob);
    },

    writeBlobFile(filePath: string): SHA1 {
      const content = readFileSync(filePath);
      return this.writeBlob(content);
    },

    catFile(hash: SHA1): GitObject {
      return objects.read(hash);
    },

    catFileType(hash: SHA1): string {
      const obj = objects.read(hash);
      return obj.type;
    },

    listObjects(): SHA1[] {
      return objects.list();
    },

    writeTree(dirPath: string): SHA1 {
      return writeTreeRecursive(objects, dirPath);
    },

    createTree(entries: TreeEntry[]): SHA1 {
      const tree: GitTree = { type: "tree", entries };
      return objects.write(tree);
    },

    createCommit(
      tree: SHA1,
      parents: SHA1[],
      message: string,
      author: GitAuthor,
      committer?: GitAuthor,
    ): SHA1 {
      const commit: GitCommit = {
        type: "commit",
        tree,
        parents,
        author,
        committer: committer ?? author,
        message,
      };
      return objects.write(commit);
    },

    updateRef(ref: string, hash: SHA1): void {
      refs.writeRaw(ref, hash);
    },

    readRef(ref: string): SHA1 | null {
      return resolveRefHash(refs, ref);
    },

    getCurrentBranch(): string | null {
      const symbolicRef = resolveSymbolicRef(refs, HEAD_REF);
      if (!symbolicRef || !symbolicRef.startsWith(HEADS_PREFIX)) {
        return null;
      }
      return symbolicRef.slice(HEADS_PREFIX.length);
    },

    createBranch(name: string, hash?: SHA1): void {
      const ref = branchNameToRef(name);
      ensureRefDoesNotExist(ref, "Branch", name);
      refs.writeRaw(ref, resolveTargetHash(refs, hash));
    },

    readBranch(name: string): SHA1 | null {
      return resolveRefHash(refs, branchNameToRef(name));
    },

    listBranches(): string[] {
      return listShortRefs(HEADS_PREFIX);
    },

    deleteBranch(name: string): void {
      const currentBranch = this.getCurrentBranch();
      if (currentBranch === name) {
        throw new Error(`Cannot delete current branch: ${name}`);
      }
      refs.deleteRaw(branchNameToRef(name));
    },

    createTag(name: string, hash?: SHA1): void {
      const ref = tagNameToRef(name);
      ensureRefDoesNotExist(ref, "Tag", name);
      refs.writeRaw(ref, resolveTargetHash(refs, hash));
    },

    createAnnotatedTag(
      name: string,
      target: SHA1,
      message: string,
      tagger: GitAuthor,
      objectType?: ObjectType,
    ): SHA1 {
      const ref = tagNameToRef(name);
      ensureRefDoesNotExist(ref, "Tag", name);

      const resolvedObjectType = objectType ?? objects.read(target).type;
      const tag: GitTag = {
        type: "tag",
        object: target,
        objectType: resolvedObjectType,
        tag: name,
        tagger,
        message,
      };
      const tagHash = objects.write(tag);
      refs.writeRaw(ref, tagHash);
      return tagHash;
    },

    readTag(name: string): SHA1 | null {
      return resolveRefHash(refs, tagNameToRef(name));
    },

    listTags(): string[] {
      return listShortRefs(TAGS_PREFIX);
    },

    deleteTag(name: string): void {
      refs.deleteRaw(tagNameToRef(name));
    },

    writePack(hashes?: SHA1[]): PackBuildResult {
      if (!packs) {
        throw new Error("Backend does not support packfile writes");
      }

      return packs.writeFromSource(objects, hashes ?? objects.list());
    },

    repack(options?: RepositoryRepackOptions): PackBuildResult {
      if (!packs) {
        throw new Error("Backend does not support repack");
      }

      return packs.repack(objects, options);
    },
  };
}

// ============================================================================
// Ref 辅助函数
// ============================================================================

/**
 * 递归将目录写入 tree 对象
 *
 * 遍历目录，为每个文件创建 blob，为每个子目录递归创建 tree，
 * 最后将所有条目组合成一个 tree 对象。
 */
function writeTreeRecursive(store: ObjectStore, dirPath: string): SHA1 {
  const entries: TreeEntry[] = [];
  const items = readdirSync(dirPath).sort();

  for (const name of items) {
    // 跳过 .git 目录
    if (name === ".git") continue;

    const fullPath = join(dirPath, name);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // 递归处理子目录
      const subtreeHash = writeTreeRecursive(store, fullPath);
      entries.push({
        mode: "40000",
        name,
        hash: subtreeHash,
      });
    } else if (stat.isFile()) {
      // 读取文件并写入 blob
      const content = readFileSync(fullPath);
      const blob: GitBlob = { type: "blob", content };
      const blobHash = store.write(blob);

      // 判断是否可执行
      const mode = stat.mode & 0o111 ? "100755" : "100644";

      entries.push({
        mode,
        name,
        hash: blobHash,
      });
    }
    // 跳过符号链接等其他类型
  }

  const tree: GitTree = { type: "tree", entries };
  return store.write(tree);
}
