/**
 * Git 仓库高层 API
 *
 * 提供类似 git 命令行的高层操作：
 * - init: 初始化仓库
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
import { sha1 } from "./types.ts";
import { hashObject } from "./hash.ts";
import { createFileObjectStore, createMemoryObjectStore, type ObjectStore } from "./store/index.ts";
import { createFileRefStore, createMemoryRefStore } from "./refs/index.ts";
import type { RefStore } from "./refs/index.ts";
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

/**
 * Git 仓库接口
 */
export interface Repository {
  /** 底层对象存储 */
  readonly store: ObjectStore;

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

  return openRepository(path);
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

  const store = createFileObjectStore(gitDir);

  return createRepository(store, gitDir);
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
  const store = createMemoryObjectStore();
  return createRepository(store, null);
}

/**
 * 创建仓库实例的内部工厂函数
 */
function createRepository(store: ObjectStore, gitDir: string | null): Repository {
  const refStore: RefStore = gitDir
    ? createFileRefStore(gitDir)
    : createMemoryRefStore(new Map<string, string>([[HEAD_REF, `ref: ${HEADS_PREFIX}main`]]));

  function ensureRefDoesNotExist(ref: string, kind: "Branch" | "Tag", name: string): void {
    if (refStore.readRaw(ref) !== null) {
      throw new Error(`${kind} already exists: ${name}`);
    }
  }

  function listShortRefs(prefix: string): string[] {
    return refStore.listRaw(prefix).map((ref) => ref.slice(prefix.length));
  }

  return {
    store,
    gitDir,

    hashObject(data: Buffer): SHA1 {
      return hashObject("blob", data);
    },

    writeBlob(data: Buffer): SHA1 {
      const blob: GitBlob = { type: "blob", content: data };
      return store.write(blob);
    },

    writeBlobFile(filePath: string): SHA1 {
      const content = readFileSync(filePath);
      return this.writeBlob(content);
    },

    catFile(hash: SHA1): GitObject {
      return store.read(hash);
    },

    catFileType(hash: SHA1): string {
      const obj = store.read(hash);
      return obj.type;
    },

    writeTree(dirPath: string): SHA1 {
      return writeTreeRecursive(store, dirPath);
    },

    createTree(entries: TreeEntry[]): SHA1 {
      const tree: GitTree = { type: "tree", entries };
      return store.write(tree);
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
      return store.write(commit);
    },

    updateRef(ref: string, hash: SHA1): void {
      refStore.writeRaw(ref, hash);
    },

    readRef(ref: string): SHA1 | null {
      return resolveRefHash(refStore, ref);
    },

    getCurrentBranch(): string | null {
      const symbolicRef = resolveSymbolicRef(refStore, HEAD_REF);
      if (!symbolicRef || !symbolicRef.startsWith(HEADS_PREFIX)) {
        return null;
      }
      return symbolicRef.slice(HEADS_PREFIX.length);
    },

    createBranch(name: string, hash?: SHA1): void {
      const ref = branchNameToRef(name);
      ensureRefDoesNotExist(ref, "Branch", name);
      refStore.writeRaw(ref, resolveTargetHash(refStore, hash));
    },

    readBranch(name: string): SHA1 | null {
      return resolveRefHash(refStore, branchNameToRef(name));
    },

    listBranches(): string[] {
      return listShortRefs(HEADS_PREFIX);
    },

    deleteBranch(name: string): void {
      const currentBranch = this.getCurrentBranch();
      if (currentBranch === name) {
        throw new Error(`Cannot delete current branch: ${name}`);
      }
      refStore.deleteRaw(branchNameToRef(name));
    },

    createTag(name: string, hash?: SHA1): void {
      const ref = tagNameToRef(name);
      ensureRefDoesNotExist(ref, "Tag", name);
      refStore.writeRaw(ref, resolveTargetHash(refStore, hash));
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

      const resolvedObjectType = objectType ?? store.read(target).type;
      const tag: GitTag = {
        type: "tag",
        object: target,
        objectType: resolvedObjectType,
        tag: name,
        tagger,
        message,
      };
      const tagHash = store.write(tag);
      refStore.writeRaw(ref, tagHash);
      return tagHash;
    },

    readTag(name: string): SHA1 | null {
      return resolveRefHash(refStore, tagNameToRef(name));
    },

    listTags(): string[] {
      return listShortRefs(TAGS_PREFIX);
    },

    deleteTag(name: string): void {
      refStore.deleteRaw(tagNameToRef(name));
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
