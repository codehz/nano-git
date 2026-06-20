/**
 * repository.ts 单元测试
 *
 * 测试仓库高层 API（内存仓库和文件系统仓库）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createMemoryRepository,
  initRepository,
  openRepository,
  type Repository,
} from "../src/repository.ts";
import { sha1 } from "../src/types.ts";
import type { GitAuthor, TreeEntry } from "../src/types.ts";

const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

// ============================================================================
// 内存仓库
// ============================================================================

describe("createMemoryRepository()", () => {
  let repo: Repository;

  beforeEach(() => {
    repo = createMemoryRepository();
  });

  test("gitDir 为 null", () => {
    expect(repo.gitDir).toBeNull();
  });

  test("hashObject() 计算 blob 哈希（不写入存储）", () => {
    const hash = repo.hashObject(Buffer.from("hello world"));
    expect(hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));
    // hashObject 不写入存储，所以 catFile 应该抛出异常
    expect(() => repo.catFile(hash)).toThrow("Object not found");
  });

  test("writeBlob() 写入并返回哈希", () => {
    const hash = repo.writeBlob(Buffer.from("hello world"));
    expect(hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));

    // 可以读取回来
    const obj = repo.catFile(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("hello world");
    }
  });

  test("catFileType() 返回正确的对象类型", () => {
    const blobHash = repo.writeBlob(Buffer.from("test"));
    expect(repo.catFileType(blobHash)).toBe("blob");

    const treeHash = repo.createTree([]);
    expect(repo.catFileType(treeHash)).toBe("tree");
  });

  test("createTree() 创建 tree 对象", () => {
    const fileHash = repo.writeBlob(Buffer.from("content"));
    const treeHash = repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]);

    const tree = repo.catFile(treeHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("file.txt");
      expect(tree.entries[0]!.mode).toBe("100644");
      expect(tree.entries[0]!.hash).toBe(fileHash);
    }
  });

  test("createCommit() 创建 commit 对象", () => {
    const treeHash = repo.createTree([]);
    const commitHash = repo.createCommit(treeHash, [], "Initial commit", testAuthor);

    const commit = repo.catFile(commitHash);
    expect(commit.type).toBe("commit");
    if (commit.type === "commit") {
      expect(commit.tree).toBe(treeHash);
      expect(commit.parents).toHaveLength(0);
      expect(commit.message).toBe("Initial commit");
      expect(commit.author.name).toBe("Test User");
      expect(commit.committer.name).toBe("Test User");
    }
  });

  test("createCommit() 使用单独的 committer", () => {
    const treeHash = repo.createTree([]);
    const committer: GitAuthor = {
      name: "Committer",
      email: "committer@example.com",
      timestamp: 1700000001,
      timezone: "+0000",
    };

    const commitHash = repo.createCommit(treeHash, [], "Test", testAuthor, committer);

    const commit = repo.catFile(commitHash);
    if (commit.type === "commit") {
      expect(commit.author.name).toBe("Test User");
      expect(commit.committer.name).toBe("Committer");
    }
  });

  test("createCommit() 支持父 commit", () => {
    const treeHash = repo.createTree([]);
    const parentHash = repo.createCommit(treeHash, [], "First", testAuthor);
    const childHash = repo.createCommit(treeHash, [parentHash], "Second", testAuthor);

    const child = repo.catFile(childHash);
    if (child.type === "commit") {
      expect(child.parents).toHaveLength(1);
      expect(child.parents[0]).toBe(parentHash);
    }
  });

  test("内存仓库支持 updateRef() 和 readRef()", () => {
    const hash = sha1("1111111111111111111111111111111111111111");
    repo.updateRef("refs/heads/main", hash);
    expect(repo.readRef("refs/heads/main")).toBe(hash);
  });

  test("内存仓库默认 HEAD 指向 main", () => {
    expect(repo.getCurrentBranch()).toBe("main");
  });

  test("内存仓库的 readRef 对不存在的 ref 返回 null", () => {
    expect(repo.readRef("refs/heads/main")).toBeNull();
  });

  test("createBranch() / listBranches() / deleteBranch() 配合工作", () => {
    const hash = sha1("2222222222222222222222222222222222222222");
    repo.createBranch("feature/test", hash);

    expect(repo.readBranch("feature/test")).toBe(hash);
    expect(repo.listBranches()).toEqual(["feature/test"]);

    repo.deleteBranch("feature/test");
    expect(repo.readBranch("feature/test")).toBeNull();
  });

  test("deleteBranch() 不允许删除当前分支", () => {
    const hash = sha1("3333333333333333333333333333333333333333");
    repo.updateRef("refs/heads/main", hash);

    expect(() => repo.deleteBranch("main")).toThrow("Cannot delete current branch: main");
  });

  test("createTag() / listTags() / deleteTag() 配合工作", () => {
    const hash = sha1("4444444444444444444444444444444444444444");
    repo.createTag("v1.0.0", hash);

    expect(repo.readTag("v1.0.0")).toBe(hash);
    expect(repo.listTags()).toEqual(["v1.0.0"]);

    repo.deleteTag("v1.0.0");
    expect(repo.readTag("v1.0.0")).toBeNull();
  });

  test("createAnnotatedTag() 创建 tag 对象并更新 tag ref", () => {
    const blobHash = repo.writeBlob(Buffer.from("release"));
    const tagHash = repo.createAnnotatedTag("v2.0.0", blobHash, "Release v2.0.0\n", testAuthor);

    expect(repo.readTag("v2.0.0")).toBe(tagHash);

    const tag = repo.catFile(tagHash);
    expect(tag.type).toBe("tag");
    if (tag.type === "tag") {
      expect(tag.object).toBe(blobHash);
      expect(tag.objectType).toBe("blob");
      expect(tag.tag).toBe("v2.0.0");
      expect(tag.message).toBe("Release v2.0.0");
    }
  });
});

// ============================================================================
// 文件系统仓库
// ============================================================================

describe("initRepository()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-repo-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("创建 .git 目录结构", () => {
    initRepository(tempDir);
    expect(existsSync(join(tempDir, ".git"))).toBe(true);
    expect(existsSync(join(tempDir, ".git", "objects"))).toBe(true);
    expect(existsSync(join(tempDir, ".git", "refs", "heads"))).toBe(true);
    expect(existsSync(join(tempDir, ".git", "refs", "tags"))).toBe(true);
  });

  test("HEAD 指向 refs/heads/main", () => {
    initRepository(tempDir);
    const head = readFileSync(join(tempDir, ".git", "HEAD"), "utf-8");
    expect(head.trim()).toBe("ref: refs/heads/main");
  });

  test("返回可用的 Repository 实例", () => {
    const repo = initRepository(tempDir);
    expect(repo.gitDir).toBe(join(tempDir, ".git"));
    expect(repo.store).toBeDefined();
  });
});

describe("openRepository()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-repo-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("打开已初始化的仓库", () => {
    initRepository(tempDir);
    const repo = openRepository(tempDir);
    expect(repo.gitDir).toBe(join(tempDir, ".git"));
  });

  test("打开不存在的仓库应抛出异常", () => {
    expect(() => openRepository(tempDir)).toThrow("Not a git repository");
  });
});

describe("文件系统仓库的 ref 操作", () => {
  let tempDir: string;
  let repo: Repository;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-repo-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
    repo = initRepository(tempDir);
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("updateRef() 和 readRef() 配合工作", () => {
    const hash = sha1("1111111111111111111111111111111111111111");
    repo.updateRef("refs/heads/main", hash);
    expect(repo.readRef("refs/heads/main")).toBe(hash);
  });

  test("readRef() 解析符号引用（HEAD）", () => {
    const hash = sha1("2222222222222222222222222222222222222222");
    repo.updateRef("refs/heads/main", hash);
    // HEAD -> refs/heads/main -> hash
    expect(repo.readRef("HEAD")).toBe(hash);
  });

  test("readRef() 对不存在的 ref 返回 null", () => {
    expect(repo.readRef("refs/heads/nonexistent")).toBeNull();
  });

  test("getCurrentBranch() 返回当前分支名", () => {
    expect(repo.getCurrentBranch()).toBe("main");
  });

  test("createBranch() 默认从 HEAD 创建分支", () => {
    const treeHash = repo.createTree([]);
    const commitHash = repo.createCommit(treeHash, [], "base", testAuthor);
    repo.updateRef("refs/heads/main", commitHash);

    repo.createBranch("feature");
    expect(repo.readBranch("feature")).toBe(commitHash);
  });

  test("listBranches() 返回排序后的分支名", () => {
    const hash1 = sha1("3333333333333333333333333333333333333333");
    const hash2 = sha1("4444444444444444444444444444444444444444");
    repo.createBranch("z-last", hash1);
    repo.createBranch("feature/api", hash2);

    expect(repo.listBranches()).toEqual(["feature/api", "z-last"]);
  });

  test("deleteBranch() 删除分支 ref", () => {
    const hash = sha1("5555555555555555555555555555555555555555");
    repo.createBranch("feature/delete", hash);

    repo.deleteBranch("feature/delete");
    expect(repo.readBranch("feature/delete")).toBeNull();
  });

  test("createTag() 默认从 HEAD 创建轻量标签", () => {
    const treeHash = repo.createTree([]);
    const commitHash = repo.createCommit(treeHash, [], "release", testAuthor);
    repo.updateRef("refs/heads/main", commitHash);

    repo.createTag("v1.0.0");
    expect(repo.readTag("v1.0.0")).toBe(commitHash);
  });

  test("createAnnotatedTag() 创建 annotated tag", () => {
    const treeHash = repo.createTree([]);
    const commitHash = repo.createCommit(treeHash, [], "release", testAuthor);

    const tagHash = repo.createAnnotatedTag("v2.0.0", commitHash, "Version 2.0.0\n", testAuthor);

    expect(repo.readTag("v2.0.0")).toBe(tagHash);

    const tag = repo.catFile(tagHash);
    expect(tag.type).toBe("tag");
    if (tag.type === "tag") {
      expect(tag.object).toBe(commitHash);
      expect(tag.objectType).toBe("commit");
      expect(tag.tag).toBe("v2.0.0");
    }
  });

  test("listTags() 返回排序后的标签名", () => {
    const hash1 = sha1("6666666666666666666666666666666666666666");
    const hash2 = sha1("7777777777777777777777777777777777777777");
    repo.createTag("v2.0.0", hash2);
    repo.createTag("v1.0.0", hash1);

    expect(repo.listTags()).toEqual(["v1.0.0", "v2.0.0"]);
  });

  test("deleteTag() 删除标签 ref", () => {
    const hash = sha1("8888888888888888888888888888888888888888");
    repo.createTag("v9.9.9", hash);

    repo.deleteTag("v9.9.9");
    expect(repo.readTag("v9.9.9")).toBeNull();
  });

  test("updateRef() 拒绝非法 ref 名", () => {
    const hash = sha1("9999999999999999999999999999999999999999");
    expect(() => repo.updateRef("refs/heads/../../escape", hash)).toThrow("Invalid ref name");
  });
});

describe("文件系统仓库的对象操作", () => {
  let tempDir: string;
  let repo: Repository;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-repo-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
    repo = initRepository(tempDir);
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("writeBlob() 和 catFile() 配合工作", () => {
    const hash = repo.writeBlob(Buffer.from("test content"));
    const obj = repo.catFile(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("test content");
    }
  });

  test("writeBlobFile() 写入文件内容", () => {
    const filePath = join(tempDir, "test.txt");
    writeFileSync(filePath, "file content");
    const hash = repo.writeBlobFile(filePath);

    const obj = repo.catFile(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("file content");
    }
  });

  test("writeTree() 将目录写入 tree 对象", () => {
    // 创建一些文件
    writeFileSync(join(tempDir, "file1.txt"), "content1");
    writeFileSync(join(tempDir, "file2.txt"), "content2");

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      // 应该包含 file1.txt 和 file2.txt（不包含 .git）
      const names = tree.entries.map((e: TreeEntry) => e.name);
      expect(names).toContain("file1.txt");
      expect(names).toContain("file2.txt");
      expect(names).not.toContain(".git");
    }
  });

  test("writeTree() 递归处理子目录", () => {
    writeFileSync(join(tempDir, "root.txt"), "root");
    mkdirSync(join(tempDir, "subdir"));
    writeFileSync(join(tempDir, "subdir", "nested.txt"), "nested");

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      const subdirEntry = tree.entries.find((e: TreeEntry) => e.name === "subdir");
      expect(subdirEntry).toBeDefined();
      expect(subdirEntry!.mode).toBe("40000");

      // 读取子目录 tree
      const subtree = repo.catFile(subdirEntry!.hash);
      expect(subtree.type).toBe("tree");
      if (subtree.type === "tree") {
        expect(subtree.entries).toHaveLength(1);
        expect(subtree.entries[0]!.name).toBe("nested.txt");
      }
    }
  });
});
