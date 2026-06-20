/**
 * Packfile 端到端兼容性测试
 *
 * 验证 nano-git 生成的 Packfile 能被标准 git 正确读取，
 * 以及 git 生成的 Packfile 能被 nano-git 正确读取。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GitBlob, GitTree, GitCommit, GitAuthor } from "../../src/types.ts";
import { createPackBuilder } from "../../src/pack/pack-builder.ts";
import { createPackObjectStore } from "../../src/pack/pack-store.ts";
import { gitInit, git, createTempDir, cleanupDir, createFile, FIXED_AUTHOR } from "./helpers.ts";

const testAuthor: GitAuthor = {
  name: FIXED_AUTHOR.name,
  email: FIXED_AUTHOR.email,
  timestamp: FIXED_AUTHOR.timestamp,
  timezone: FIXED_AUTHOR.timezone,
};

// ============================================================================
// nano-git → git 兼容性
// ============================================================================

describe("Packfile 兼容性: nano-git → git", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-pack-n2g");
    gitInit(tempDir);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  test("nano-git 创建的 packfile 能被 git verify-pack 验证", () => {
    const gitDir = join(tempDir, ".git");
    const builder = createPackBuilder(gitDir);

    const blob: GitBlob = { type: "blob", content: Buffer.from("hello from nano-git pack") };
    builder.addObject(blob);

    const result = builder.build();
    expect(existsSync(result.packPath)).toBe(true);
    expect(existsSync(result.idxPath)).toBe(true);

    // 用 git verify-pack 验证
    const output = git(["verify-pack", "-v", result.idxPath], tempDir);
    expect(output).toContain("blob");
  });

  test("nano-git 打包的 blob 能被 git cat-file 读取", () => {
    const gitDir = join(tempDir, ".git");
    const builder = createPackBuilder(gitDir);

    const content = "packed blob content";
    const blob: GitBlob = { type: "blob", content: Buffer.from(content) };
    const hash = builder.addObject(blob);
    builder.build();

    // 用 git cat-file 读取
    const gitContent = git(["cat-file", "-p", hash], tempDir);
    expect(gitContent).toBe(content);
  });

  test("nano-git 打包的 tree 能被 git cat-file 读取", () => {
    const gitDir = join(tempDir, ".git");
    const builder = createPackBuilder(gitDir);

    const blob: GitBlob = { type: "blob", content: Buffer.from("file content") };
    const blobHash = builder.addObject(blob);

    const tree: GitTree = {
      type: "tree",
      entries: [{ mode: "100644", name: "test.txt", hash: blobHash }],
    };
    const treeHash = builder.addObject(tree);
    builder.build();

    // 用 git cat-file 读取 tree
    const output = git(["cat-file", "-p", treeHash], tempDir);
    expect(output).toContain("test.txt");
    expect(output).toContain(blobHash);
  });

  test("nano-git 打包的 commit 能被 git cat-file 读取", () => {
    const gitDir = join(tempDir, ".git");
    const builder = createPackBuilder(gitDir);

    const tree: GitTree = { type: "tree", entries: [] };
    const treeHash = builder.addObject(tree);

    const commit: GitCommit = {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: testAuthor,
      committer: testAuthor,
      message: "packed commit",
    };
    const commitHash = builder.addObject(commit);
    builder.build();

    // 用 git cat-file 读取
    const output = git(["cat-file", "-p", commitHash], tempDir);
    expect(output).toContain("packed commit");
    expect(output).toContain(treeHash);
  });
});

// ============================================================================
// git → nano-git 兼容性
// ============================================================================

describe("Packfile 兼容性: git → nano-git", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-pack-g2n");
    gitInit(tempDir);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  test("git repack 生成的 packfile 能被 nano-git 读取", () => {
    // 用 git 创建一些对象
    createFile(tempDir, "file1.txt", "content 1");
    createFile(tempDir, "file2.txt", "content 2");

    git(["add", "."], tempDir);
    git(["commit", "-m", "test commit"], tempDir);

    // 强制 repack
    git(["repack", "-a", "-d"], tempDir);

    // 用 nano-git 读取
    const gitDir = join(tempDir, ".git");
    const store = createPackObjectStore(gitDir);

    expect(store.packCount).toBeGreaterThan(0);
    expect(store.objectCount).toBeGreaterThan(0);

    // 验证能列出所有哈希
    const hashes = store.listHashes();
    expect(hashes.length).toBeGreaterThan(0);

    // 验证每个对象都能读取
    for (const hash of hashes) {
      const obj = store.read(hash);
      expect(obj).toBeDefined();
      expect(["blob", "tree", "commit"]).toContain(obj.type);
    }
  });

  test("git gc 后的 packfile 能被 nano-git 正确解析", () => {
    // 创建多个 commit
    for (let i = 0; i < 5; i++) {
      createFile(tempDir, `file${i}.txt`, `content ${i}`);
      git(["add", "."], tempDir);
      git(["commit", "-m", `commit ${i}`], tempDir);
    }

    // 运行 gc
    git(["gc", "--aggressive"], tempDir);

    // 用 nano-git 读取
    const gitDir = join(tempDir, ".git");
    const store = createPackObjectStore(gitDir);

    expect(store.packCount).toBeGreaterThan(0);

    // 验证所有对象都能读取
    const hashes = store.listHashes();
    for (const hash of hashes) {
      expect(() => store.read(hash)).not.toThrow();
    }
  });
});
