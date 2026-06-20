/**
 * repository 单元测试
 *
 * 测试仓库高层 API（内存仓库和文件系统仓库）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashToPath } from "../src/core/hash.ts";
import { createPackBuilder } from "../src/odb/pack/index.ts";
import {
  createRepository,
  createMemoryRepository,
  initRepository,
  openRepository,
  type Repository,
} from "../src/repository/index.ts";
import {
  createFileRepositoryBackend,
  createMemoryRepositoryBackend,
  type RepositoryBackend,
} from "../src/repository/backend/index.ts";
import { sha1 } from "../src/core/types.ts";
import type { GitAuthor, GitTree, TreeEntry } from "../src/core/types.ts";

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
// patchTree 增量 tree 操作
// ============================================================================

describe("patchTree()", () => {
  let repo: Repository;

  beforeEach(() => {
    repo = createMemoryRepository();
  });

  test("upsert 新文件到根目录", () => {
    const rootHash = repo.createTree([]);
    const blobHash = repo.writeBlob(Buffer.from("content"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "file.txt", mode: "100644", hash: blobHash },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("file.txt");
      expect(tree.entries[0]!.mode).toBe("100644");
      expect(tree.entries[0]!.hash).toBe(blobHash);
    }
    expect(result.writtenTrees).toContain(result.rootHash);
  });

  test("upsert 符号链接", () => {
    const rootHash = repo.createTree([]);
    const targetHash = repo.writeBlob(Buffer.from("/usr/bin/node"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "node", mode: "120000", hash: targetHash },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("node");
      expect(tree.entries[0]!.mode).toBe("120000");
    }
  });

  test("upsert 到新子目录（自动创建中间目录）", () => {
    const rootHash = repo.createTree([]);
    const blobHash = repo.writeBlob(Buffer.from("nested content"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "a/b/c/file.txt", mode: "100644", hash: blobHash },
    ]);

    // 验证根 tree: a/
    const root = repo.catFile(result.rootHash);
    expect(root.type).toBe("tree");
    if (root.type === "tree") {
      expect(root.entries).toHaveLength(1);
      expect(root.entries[0]!.name).toBe("a");
      expect(root.entries[0]!.mode).toBe("40000");
    }

    // 验证 a/: b/
    const aTree = repo.catFile((root as GitTree).entries.find((e) => e.name === "a")!.hash);
    expect(aTree.type).toBe("tree");
    if (aTree.type === "tree") {
      expect(aTree.entries).toHaveLength(1);
      expect(aTree.entries[0]!.name).toBe("b");
    }

    // 验证 b/: c/
    const bTree = repo.catFile((aTree as GitTree).entries.find((e) => e.name === "b")!.hash);
    expect(bTree.type).toBe("tree");
    if (bTree.type === "tree") {
      expect(bTree.entries).toHaveLength(1);
      expect(bTree.entries[0]!.name).toBe("c");
    }

    // 验证 c/: file.txt
    const cTree = repo.catFile((bTree as GitTree).entries.find((e) => e.name === "c")!.hash);
    expect(cTree.type).toBe("tree");
    if (cTree.type === "tree") {
      expect(cTree.entries).toHaveLength(1);
      expect(cTree.entries[0]!.name).toBe("file.txt");
      expect(cTree.entries[0]!.hash).toBe(blobHash);
    }
  });

  test("upsert 替换已有文件", () => {
    const oldHash = repo.writeBlob(Buffer.from("old"));
    const rootHash = repo.createTree([{ mode: "100644", name: "file.txt", hash: oldHash }]);
    const newHash = repo.writeBlob(Buffer.from("new"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "file.txt", mode: "100755", hash: newHash },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("file.txt");
      expect(tree.entries[0]!.mode).toBe("100755");
      expect(tree.entries[0]!.hash).toBe(newHash);
    }
  });

  test("upsert 替换子树中的文件", () => {
    const oldHash = repo.writeBlob(Buffer.from("old"));
    const subTreeHash = repo.createTree([{ mode: "100644", name: "old.txt", hash: oldHash }]);
    const rootHash = repo.createTree([{ mode: "40000", name: "sub", hash: subTreeHash }]);

    const newHash = repo.writeBlob(Buffer.from("new"));
    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "sub/old.txt", mode: "100644", hash: newHash },
    ]);

    const root = repo.catFile(result.rootHash);
    expect(root.type).toBe("tree");
    if (root.type === "tree") {
      expect(root.entries).toHaveLength(1);
      const sub = repo.catFile(root.entries[0]!.hash);
      expect(sub.type).toBe("tree");
      if (sub.type === "tree") {
        expect(sub.entries).toHaveLength(1);
        expect(sub.entries[0]!.hash).toBe(newHash);
      }
    }
  });

  test("delete 删除已有文件", () => {
    const blobHash = repo.writeBlob(Buffer.from("to-delete"));
    const rootHash = repo.createTree([
      { mode: "100644", name: "keep.txt", hash: repo.writeBlob(Buffer.from("keep")) },
      { mode: "100644", name: "delete.txt", hash: blobHash },
    ]);

    const result = repo.patchTree(rootHash, [{ op: "delete", path: "delete.txt" }]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("keep.txt");
    }
  });

  test("delete 不存在的路径应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "delete", path: "nonexistent.txt" }])).toThrow(
      "path does not exist",
    );
  });

  test("delete 支持删除目录条目", () => {
    const subHash = repo.createTree([
      { mode: "100644", name: "f.txt", hash: repo.writeBlob(Buffer.from("f")) },
    ]);
    const rootHash = repo.createTree([{ mode: "40000", name: "subdir", hash: subHash }]);

    const result = repo.patchTree(rootHash, [{ op: "delete", path: "subdir" }]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(0);
    }
  });

  test("delete 深层路径不存在的文件应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "delete", path: "a/b/c/file.txt" }])).toThrow(
      "path does not exist",
    );
  });

  test("同路径多次操作最后一个生效（最后是 upsert）", () => {
    const rootHash = repo.createTree([]);
    const hash1 = repo.writeBlob(Buffer.from("first"));
    const hash2 = repo.writeBlob(Buffer.from("second"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "f.txt", mode: "100644", hash: hash1 },
      { op: "delete", path: "f.txt" },
      { op: "upsert", path: "f.txt", mode: "100755", hash: hash2 },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.hash).toBe(hash2);
      expect(tree.entries[0]!.mode).toBe("100755");
    }
  });

  test("同路径多次操作最后一个生效（最后是 delete）", () => {
    const rootHash = repo.createTree([]);
    const hash = repo.writeBlob(Buffer.from("content"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "f.txt", mode: "100644", hash },
      { op: "delete", path: "f.txt" },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(0);
    }
  });

  test("同时在多个不同路径 upsert", () => {
    const rootHash = repo.createTree([]);
    const h1 = repo.writeBlob(Buffer.from("a"));
    const h2 = repo.writeBlob(Buffer.from("b"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "src/a.ts", mode: "100644", hash: h1 },
      { op: "upsert", path: "src/b.ts", mode: "100644", hash: h2 },
      { op: "upsert", path: "README.md", mode: "100644", hash: h1 },
    ]);

    const root = repo.catFile(result.rootHash);
    expect(root.type).toBe("tree");
    if (root.type === "tree") {
      expect(root.entries).toHaveLength(2); // README.md + src
      const srcEntry = root.entries.find((e) => e.name === "src")!;
      expect(srcEntry).toBeDefined();

      const src = repo.catFile(srcEntry.hash);
      expect(src.type).toBe("tree");
      if (src.type === "tree") {
        expect(src.entries).toHaveLength(2);
        expect(src.entries.find((e) => e.name === "a.ts")!.hash).toBe(h1);
        expect(src.entries.find((e) => e.name === "b.ts")!.hash).toBe(h2);
      }
    }
  });

  test("空操作列表返回原 tree", () => {
    const blobHash = repo.writeBlob(Buffer.from("content"));
    const rootHash = repo.createTree([{ mode: "100644", name: "f.txt", hash: blobHash }]);

    const result = repo.patchTree(rootHash, []);

    expect(result.rootHash).toBe(rootHash);
    expect(result.writtenTrees).toHaveLength(0);
  });

  test("writtenTrees 包含所有新写入的中间 tree", () => {
    const rootHash = repo.createTree([]);
    const blobHash = repo.writeBlob(Buffer.from("deep"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "x/y/z.txt", mode: "100644", hash: blobHash },
    ]);

    // 应该包含叶子 tree (x/y) 和根 tree (x)，以及根 tree
    // 总共 3 个新 tree（x, x/y, root）
    expect(result.writtenTrees.length).toBeGreaterThanOrEqual(3);
    // 根 tree hash 应该在结果中
    expect(result.writtenTrees).toContain(result.rootHash);
  });

  test("路径格式校验：空路径应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "delete", path: "" }])).toThrow(
      "Path must not be empty",
    );
  });

  test("路径格式校验：以斜杠开头应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "delete", path: "/file.txt" }])).toThrow(
      "Path must not start with '/'",
    );
  });

  test("路径格式校验：以斜杠结尾应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "delete", path: "dir/" }])).toThrow(
      "Path must not end with '/'",
    );
  });

  test("路径格式校验：包含 .. 应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "delete", path: "../escape" }])).toThrow(
      "Path must not contain '.' or '..'",
    );
  });

  // ---- rename 操作 ----

  test("rename 文件在同层目录", () => {
    const hash = repo.writeBlob(Buffer.from("content"));
    const rootHash = repo.createTree([{ mode: "100644", name: "old.txt", hash }]);

    const result = repo.patchTree(rootHash, [{ op: "rename", from: "old.txt", to: "new.txt" }]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("new.txt");
      expect(tree.entries[0]!.hash).toBe(hash);
      expect(tree.entries[0]!.mode).toBe("100644");
    }
  });

  test("rename 符号链接", () => {
    const targetHash = repo.writeBlob(Buffer.from("/usr/bin/node"));
    const rootHash = repo.createTree([{ mode: "120000", name: "old-link", hash: targetHash }]);

    const result = repo.patchTree(rootHash, [{ op: "rename", from: "old-link", to: "new-link" }]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("new-link");
      expect(tree.entries[0]!.mode).toBe("120000");
      expect(tree.entries[0]!.hash).toBe(targetHash);
    }
  });

  test("rename 目录（子树平移，tree hash 不变）", () => {
    const subHash = repo.createTree([
      { mode: "100644", name: "a.txt", hash: repo.writeBlob(Buffer.from("a")) },
    ]);
    const rootHash = repo.createTree([{ mode: "40000", name: "src", hash: subHash }]);

    const result = repo.patchTree(rootHash, [{ op: "rename", from: "src", to: "lib" }]);

    // 根 tree：只有 lib，没有 src
    const root = repo.catFile(result.rootHash);
    expect(root.type).toBe("tree");
    if (root.type === "tree") {
      expect(root.entries).toHaveLength(1);
      expect(root.entries[0]!.name).toBe("lib");
      expect(root.entries[0]!.mode).toBe("40000");
      // 子树 hash 不变（直接移动 tree entry 引用）
      expect(root.entries[0]!.hash).toBe(subHash);
    }
  });

  test("rename 跨目录移动文件", () => {
    const hash = repo.writeBlob(Buffer.from("content"));
    const subHash = repo.createTree([]);
    const rootHash = repo.createTree([
      { mode: "100644", name: "file.txt", hash },
      { mode: "40000", name: "subdir", hash: subHash },
    ]);

    const result = repo.patchTree(rootHash, [
      { op: "rename", from: "file.txt", to: "subdir/file.txt" },
    ]);

    const root = repo.catFile(result.rootHash);
    expect(root.type).toBe("tree");
    if (root.type === "tree") {
      expect(root.entries).toHaveLength(1); // 只剩下 subdir
      const sub = repo.catFile(root.entries[0]!.hash);
      expect(sub.type).toBe("tree");
      if (sub.type === "tree") {
        expect(sub.entries).toHaveLength(1);
        expect(sub.entries[0]!.name).toBe("file.txt");
        expect(sub.entries[0]!.hash).toBe(hash);
      }
    }
  });

  test("rename 跨目录且自动创建中间目录", () => {
    const hash = repo.writeBlob(Buffer.from("nested"));
    const rootHash = repo.createTree([{ mode: "100644", name: "old.txt", hash }]);

    const result = repo.patchTree(rootHash, [
      { op: "rename", from: "old.txt", to: "a/b/c/new.txt" },
    ]);

    // 验证根 tree: a/
    const root = repo.catFile(result.rootHash);
    expect(root.type).toBe("tree");
    if (root.type === "tree") {
      expect(root.entries).toHaveLength(1);
      expect(root.entries[0]!.name).toBe("a");
    }
  });

  test("rename 到已存在的路径（覆盖）", () => {
    const oldHash = repo.writeBlob(Buffer.from("old"));
    const newHash = repo.writeBlob(Buffer.from("new"));
    const rootHash = repo.createTree([
      { mode: "100644", name: "src", hash: oldHash },
      { mode: "100644", name: "dst", hash: newHash },
    ]);

    const result = repo.patchTree(rootHash, [{ op: "rename", from: "src", to: "dst" }]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("dst");
      expect(tree.entries[0]!.hash).toBe(oldHash); // src 的内容
    }
  });

  test("rename from 不存在应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() =>
      repo.patchTree(rootHash, [{ op: "rename", from: "nonexistent", to: "new" }]),
    ).toThrow("path does not exist");
  });

  test("rename 深层路径 from 不存在应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() =>
      repo.patchTree(rootHash, [{ op: "rename", from: "a/b/c.txt", to: "d/e.txt" }]),
    ).toThrow("path does not exist");
  });

  test("rename from === to 为 no-op", () => {
    const hash = repo.writeBlob(Buffer.from("content"));
    const rootHash = repo.createTree([{ mode: "100644", name: "f.txt", hash }]);

    const result = repo.patchTree(rootHash, [{ op: "rename", from: "f.txt", to: "f.txt" }]);

    expect(result.rootHash).toBe(rootHash); // tree 不变
    expect(result.writtenTrees).toHaveLength(0);
  });

  test("rename 链式操作：a → b → c", () => {
    const hash = repo.writeBlob(Buffer.from("content"));
    const rootHash = repo.createTree([{ mode: "100644", name: "a", hash }]);

    const result = repo.patchTree(rootHash, [
      { op: "rename", from: "a", to: "b" },
      { op: "rename", from: "b", to: "c" },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("c");
      expect(tree.entries[0]!.hash).toBe(hash);
    }
  });

  test("rename 与 upsert 交错执行", () => {
    const hash1 = repo.writeBlob(Buffer.from("first"));
    const hash2 = repo.writeBlob(Buffer.from("second"));
    const rootHash = repo.createTree([{ mode: "100644", name: "a", hash: hash1 }]);

    // rename a → b, 然后 upsert 新的 a
    const result = repo.patchTree(rootHash, [
      { op: "rename", from: "a", to: "b" },
      { op: "upsert", path: "a", mode: "100644", hash: hash2 },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(2);
      expect(tree.entries.find((e) => e.name === "a")!.hash).toBe(hash2);
      expect(tree.entries.find((e) => e.name === "b")!.hash).toBe(hash1);
    }
  });

  test("rename 与 delete 交错执行", () => {
    const hash = repo.writeBlob(Buffer.from("content"));
    const rootHash = repo.createTree([
      { mode: "100644", name: "a", hash },
      { mode: "100644", name: "b", hash },
    ]);

    // delete a, 然后 rename b → a（b 被移到 a 的位置）
    const result = repo.patchTree(rootHash, [
      { op: "delete", path: "a" },
      { op: "rename", from: "b", to: "a" },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("a");
      expect(tree.entries[0]!.hash).toBe(hash);
    }
  });

  test("rename 路径格式校验：空 from/to 应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "rename", from: "", to: "new" }])).toThrow(
      "Path must not be empty",
    );
    expect(() => repo.patchTree(rootHash, [{ op: "rename", from: "old", to: "" }])).toThrow(
      "Path must not be empty",
    );
  });

  test("rename 路径格式校验：包含 .. 应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "rename", from: "../old", to: "new" }])).toThrow(
      "Path must not contain '.' or '..'",
    );
    expect(() => repo.patchTree(rootHash, [{ op: "rename", from: "old", to: "../new" }])).toThrow(
      "Path must not contain '.' or '..'",
    );
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
    expect(repo.objects).toBeDefined();
    expect(repo.refs).toBeDefined();
    expect(repo.backend.gitDir).toBe(join(tempDir, ".git"));
  });
});

describe("createRepository()", () => {
  test("基于显式后端创建仓库", () => {
    const backend = createMemoryRepositoryBackend();
    const repo = createRepository(backend);

    expect(repo.backend).toBe(backend);
    expect(repo.objects).toBe(backend.objects);
    expect(repo.refs).toBe(backend.refs);
    expect(repo.packs).toBeNull();
    expect(repo.gitDir).toBeNull();
  });

  test("允许调用方自行组合文件系统后端", () => {
    const tempDir = join(tmpdir(), `nano-git-backend-${Date.now()}-${Math.random()}`);
    mkdirSync(join(tempDir, ".git", "objects"), { recursive: true });
    mkdirSync(join(tempDir, ".git", "refs", "heads"), { recursive: true });
    mkdirSync(join(tempDir, ".git", "refs", "tags"), { recursive: true });
    writeFileSync(join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

    try {
      const backend: RepositoryBackend = createFileRepositoryBackend(join(tempDir, ".git"));
      const repo = createRepository(backend);

      expect(repo.backend.gitDir).toBe(join(tempDir, ".git"));
      expect(repo.packs).not.toBeNull();
      expect(repo.getCurrentBranch()).toBe("main");
    } finally {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
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

  test("writeTree() 处理符号链接，使用 120000 mode", () => {
    const target = "/usr/bin/node";
    symlinkSync(target, join(tempDir, "node-link"));

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      const linkEntry = tree.entries.find((e: TreeEntry) => e.name === "node-link");
      expect(linkEntry).toBeDefined();
      expect(linkEntry!.mode).toBe("120000");

      // 验证 blob 内容为链接目标路径
      const blob = repo.catFile(linkEntry!.hash);
      expect(blob.type).toBe("blob");
      if (blob.type === "blob") {
        expect(blob.content.toString("utf-8")).toBe(target);
      }
    }
  });

  test("writeTree() 处理相对路径符号链接", () => {
    symlinkSync("./relative-target.txt", join(tempDir, "rel-link"));

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      const linkEntry = tree.entries.find((e: TreeEntry) => e.name === "rel-link");
      expect(linkEntry).toBeDefined();
      expect(linkEntry!.mode).toBe("120000");

      const blob = repo.catFile(linkEntry!.hash);
      expect(blob.type).toBe("blob");
      if (blob.type === "blob") {
        expect(blob.content.toString("utf-8")).toBe("./relative-target.txt");
      }
    }
  });

  test("writeTree() 将符号链接到目录记录为 120000 而非递归遍历", () => {
    mkdirSync(join(tempDir, "real-dir"));
    writeFileSync(join(tempDir, "real-dir", "nested.txt"), "nested");
    symlinkSync("real-dir", join(tempDir, "link-to-dir"));

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      // link-to-dir 应该是 120000 符号链接，不是 40000 目录
      const linkEntry = tree.entries.find((e: TreeEntry) => e.name === "link-to-dir");
      expect(linkEntry).toBeDefined();
      expect(linkEntry!.mode).toBe("120000");

      const blob = repo.catFile(linkEntry!.hash);
      expect(blob.type).toBe("blob");
      if (blob.type === "blob") {
        expect(blob.content.toString("utf-8")).toBe("real-dir");
      }

      // real-dir 仍然是正常的 40000 目录
      const dirEntry = tree.entries.find((e: TreeEntry) => e.name === "real-dir");
      expect(dirEntry).toBeDefined();
      expect(dirEntry!.mode).toBe("40000");
    }
  });

  test("writeTree() 处理断链符号链接（目标不存在）", () => {
    symlinkSync("/nonexistent/path", join(tempDir, "broken-link"));

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      const linkEntry = tree.entries.find((e: TreeEntry) => e.name === "broken-link");
      expect(linkEntry).toBeDefined();
      expect(linkEntry!.mode).toBe("120000");

      const blob = repo.catFile(linkEntry!.hash);
      expect(blob.type).toBe("blob");
      if (blob.type === "blob") {
        expect(blob.content.toString("utf-8")).toBe("/nonexistent/path");
      }
    }
  });

  test("writeTree() 处理子目录中的符号链接", () => {
    mkdirSync(join(tempDir, "sub"));
    symlinkSync("/any/target", join(tempDir, "sub", "inner-link"));
    writeFileSync(join(tempDir, "sub", "regular.txt"), "normal");

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      const subEntry = tree.entries.find((e: TreeEntry) => e.name === "sub");
      expect(subEntry).toBeDefined();
      expect(subEntry!.mode).toBe("40000");

      // 读取子目录 tree
      const subtree = repo.catFile(subEntry!.hash);
      expect(subtree.type).toBe("tree");
      if (subtree.type === "tree") {
        expect(subtree.entries).toHaveLength(2);

        const linkEntry = subtree.entries.find((e: TreeEntry) => e.name === "inner-link");
        expect(linkEntry).toBeDefined();
        expect(linkEntry!.mode).toBe("120000");

        const blob = repo.catFile(linkEntry!.hash);
        expect(blob.type).toBe("blob");
        if (blob.type === "blob") {
          expect(blob.content.toString("utf-8")).toBe("/any/target");
        }

        const regularEntry = subtree.entries.find((e: TreeEntry) => e.name === "regular.txt");
        expect(regularEntry).toBeDefined();
        expect(regularEntry!.mode).toBe("100644");
      }
    }
  });

  test("writeTree() 混合处理文件、可执行文件和符号链接", () => {
    writeFileSync(join(tempDir, "readme.md"), "docs");
    const execPath = join(tempDir, "run.sh");
    writeFileSync(execPath, "#!/bin/sh\necho hi");
    chmodSync(execPath, 0o755);
    symlinkSync("readme.md", join(tempDir, "doc-link"));

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(3);

      const fileEntry = tree.entries.find((e: TreeEntry) => e.name === "readme.md");
      expect(fileEntry).toBeDefined();
      expect(fileEntry!.mode).toBe("100644");

      const execEntry = tree.entries.find((e: TreeEntry) => e.name === "run.sh");
      expect(execEntry).toBeDefined();
      expect(execEntry!.mode).toBe("100755");

      const linkEntry = tree.entries.find((e: TreeEntry) => e.name === "doc-link");
      expect(linkEntry).toBeDefined();
      expect(linkEntry!.mode).toBe("120000");
    }
  });

  test("openRepository() 默认可读取 packfile 中的对象", () => {
    const gitDir = join(tempDir, ".git");
    const builder = createPackBuilder(gitDir);
    const hash = builder.addObject({
      type: "blob",
      content: Buffer.from("packed-only content"),
    });
    builder.build();

    const packedRepo = openRepository(tempDir);
    const obj = packedRepo.catFile(hash);

    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("packed-only content");
    }
  });

  test("listObjects() 同时返回 loose 和 packed objects", () => {
    const gitDir = join(tempDir, ".git");
    const looseHash = repo.writeBlob(Buffer.from("loose"));

    const builder = createPackBuilder(gitDir);
    const packedHash = builder.addObject({
      type: "blob",
      content: Buffer.from("packed"),
    });
    builder.build();

    expect(repo.listObjects()).toContain(looseHash);
    expect(repo.listObjects()).toContain(packedHash);
  });

  test("writePack() 将对象写入新的 packfile", () => {
    const hash = repo.writeBlob(Buffer.from("pack me"));
    const result = repo.writePack([hash]);

    expect(result.objectCount).toBe(1);
    expect(existsSync(result.packPath)).toBe(true);
    expect(existsSync(result.idxPath)).toBe(true);
    expect(repo.packs!.source.packCount).toBe(1);

    const reopened = openRepository(tempDir);
    const obj = reopened.catFile(hash);
    expect(obj.type).toBe("blob");
  });

  test("repack() 默认替换旧 pack 文件", () => {
    repo.writeBlob(Buffer.from("first"));
    repo.writePack();

    repo.writeBlob(Buffer.from("second"));
    const result = repo.repack();

    expect(repo.packs!.source.packCount).toBe(1);
    expect(repo.packs!.source.listPacks()).toHaveLength(1);
    expect(repo.packs!.source.listPacks()[0]!.checksum).toBe(result.checksum);
  });

  test("repack({ pruneLoose: true }) 会删除已打包的 loose object 文件", () => {
    const gitDir = join(tempDir, ".git");
    const hash = repo.writeBlob(Buffer.from("packed and pruned"));
    const objectPath = join(gitDir, "objects", hashToPath(hash));

    expect(existsSync(objectPath)).toBe(true);

    repo.repack({ pruneLoose: true });

    expect(existsSync(objectPath)).toBe(false);
    const obj = repo.catFile(hash);
    expect(obj.type).toBe("blob");
  });

  test("listReachableObjects() 只返回从 refs/HEAD 可达的对象", () => {
    const reachableBlob = repo.writeBlob(Buffer.from("reachable"));
    const reachableTree = repo.createTree([
      { mode: "100644", name: "file.txt", hash: reachableBlob },
    ]);
    const reachableCommit = repo.createCommit(reachableTree, [], "reachable", testAuthor);
    repo.updateRef("refs/heads/main", reachableCommit);

    const unreachableBlob = repo.writeBlob(Buffer.from("unreachable"));
    const reachable = repo.listReachableObjects();

    expect(reachable).toContain(reachableBlob);
    expect(reachable).toContain(reachableTree);
    expect(reachable).toContain(reachableCommit);
    expect(reachable).not.toContain(unreachableBlob);
  });

  test("listReachableObjects() 会跟随 annotated tag", () => {
    const blobHash = repo.writeBlob(Buffer.from("tag target"));
    const tagHash = repo.createAnnotatedTag("v1.0.0", blobHash, "release", testAuthor, "blob");

    const reachable = repo.listReachableObjects();
    expect(reachable).toContain(tagHash);
    expect(reachable).toContain(blobHash);
  });

  test("gc() 只保留可达对象", () => {
    const gitDir = join(tempDir, ".git");
    const reachableBlob = repo.writeBlob(Buffer.from("reachable after gc"));
    const reachableTree = repo.createTree([
      { mode: "100644", name: "keep.txt", hash: reachableBlob },
    ]);
    const reachableCommit = repo.createCommit(reachableTree, [], "keep", testAuthor);
    repo.updateRef("refs/heads/main", reachableCommit);

    const danglingBlob = repo.writeBlob(Buffer.from("dangling"));
    const danglingPath = join(gitDir, "objects", hashToPath(danglingBlob));

    expect(existsSync(danglingPath)).toBe(true);

    const result = repo.gc();

    expect(result.objectCount).toBeGreaterThan(0);
    expect(existsSync(danglingPath)).toBe(false);
    expect(repo.readRef("HEAD")).toBe(reachableCommit);
    expect(repo.catFile(reachableBlob).type).toBe("blob");
    expect(repo.listReachableObjects()).not.toContain(danglingBlob);
  });
});
