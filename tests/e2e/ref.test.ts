/**
 * Ref（引用）端到端兼容性测试
 *
 * nano-git 与标准 Git 的引用系统双向兼容性验证。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { openRepository } from "../../src/repository/index.ts";
import { sha1 } from "../../src/core/types.ts";
import type { GitAuthor } from "../../src/core/types.ts";
import {
  git,
  gitInit,
  gitRevParse,
  gitWriteTreeFromFiles,
  gitCommitTree,
  gitUpdateRef,
  createTempDir,
  cleanupDir,
  FIXED_AUTHOR,
} from "./helpers.ts";

const testAuthor: GitAuthor = {
  name: FIXED_AUTHOR.name,
  email: FIXED_AUTHOR.email,
  timestamp: FIXED_AUTHOR.timestamp,
  timezone: FIXED_AUTHOR.timezone,
};

describe("Ref 兼容性", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-ref");
    gitInit(tempDir);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  // --- nano-git → git ---

  describe("nano-git → git", () => {
    test("nano-git 更新的 ref 能被 git rev-parse 读取", () => {
      const repo = openRepository(tempDir);

      const treeHash = repo.createTree([]);
      const commitHash = repo.createCommit(treeHash, [], "Ref test", testAuthor);

      repo.updateRef("refs/heads/main", commitHash);

      const gitResult = gitRevParse(tempDir, "refs/heads/main");
      expect(gitResult).toBe(commitHash);
    });

    test("nano-git 更新的 HEAD 能被 git 正确解析", () => {
      const repo = openRepository(tempDir);

      const treeHash = repo.createTree([]);
      const commitHash = repo.createCommit(treeHash, [], "HEAD test", testAuthor);

      repo.updateRef("refs/heads/main", commitHash);

      const headResult = gitRevParse(tempDir, "HEAD");
      expect(headResult).toBe(commitHash);
    });

    test("nano-git 创建的自定义分支 ref 能被 git 读取", () => {
      const repo = openRepository(tempDir);

      const treeHash = repo.createTree([]);
      const commitHash = repo.createCommit(treeHash, [], "Feature branch", testAuthor);

      repo.createBranch("feature", commitHash);

      const gitResult = gitRevParse(tempDir, "refs/heads/feature");
      expect(gitResult).toBe(commitHash);
    });

    test("nano-git 创建的分支能被 git branch 列出", () => {
      const repo = openRepository(tempDir);

      const treeHash = repo.createTree([]);
      const commitHash = repo.createCommit(treeHash, [], "Branch list", testAuthor);
      repo.updateRef("refs/heads/main", commitHash);
      repo.createBranch("feature/api");

      const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
      const result = spawnSync("git", ["branch", "--list"], {
        cwd: tempDir,
        encoding: "utf-8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("feature/api");
      expect(result.stdout).toContain("main");
    });
  });

  // --- git → nano-git ---

  describe("git → nano-git", () => {
    test("git 更新的 ref 能被 nano-git 读取", () => {
      const repo = openRepository(tempDir);

      const treeHash = gitWriteTreeFromFiles(tempDir, { "f.txt": "c" });
      const commitHash = gitCommitTree(tempDir, treeHash, "Ref test");

      gitUpdateRef(tempDir, "refs/heads/main", commitHash);

      const nanoGitResult = repo.readRef("refs/heads/main");
      expect(nanoGitResult).toBe(commitHash);
    });

    test("nano-git 能解析 git 设置的 HEAD 符号引用", () => {
      const repo = openRepository(tempDir);

      const treeHash = gitWriteTreeFromFiles(tempDir, { "f.txt": "c" });
      const commitHash = gitCommitTree(tempDir, treeHash, "HEAD test");

      gitUpdateRef(tempDir, "refs/heads/main", commitHash);

      const headResult = repo.readRef("HEAD");
      expect(headResult).toBe(commitHash);
    });
  });
});
