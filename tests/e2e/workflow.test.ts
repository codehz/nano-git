/**
 * 完整工作流端到端测试
 *
 * nano-git 与标准 Git 在完整工作流中的兼容性验证。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";

import {
  git,
  gitInit,
  gitCatFile,
  gitCatFileType,
  gitRevParse,
  gitFsck,
  gitLog,
  gitHashObjectWrite,
  gitGc,
  createTempDir,
  cleanupDir,
  createFile,
  FIXED_AUTHOR,
} from "./helpers.ts";
import { initRepository } from "@/repository/file.ts";
import { openRepository } from "@/repository/file.ts";

import type { GitAuthor } from "@/types/index.ts";

const testAuthor: GitAuthor = {
  name: FIXED_AUTHOR.name,
  email: FIXED_AUTHOR.email,
  timestamp: FIXED_AUTHOR.timestamp,
  timezone: FIXED_AUTHOR.timezone,
};

describe("完整工作流", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-workflow");
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  test("nano-git 创建的完整仓库能被 git 正常使用", () => {
    const repo = initRepository(tempDir);

    const readmeHash = repo.writeBlob(Buffer.from("# My Project\n\nHello world!\n"));
    const tree1Hash = repo.createTree([{ mode: "100644", name: "README.md", hash: readmeHash }]);
    const commit1Hash = repo.createCommit(tree1Hash, [], "Initial commit", testAuthor);
    repo.updateRef("refs/heads/main", commit1Hash);

    const srcHash = repo.writeBlob(Buffer.from('console.log("hello");\n'));
    const readmeV2Hash = repo.writeBlob(Buffer.from("# My Project\n\nHello world!\n\n## Usage\n"));
    const srcTreeHash = repo.createTree([{ mode: "100644", name: "index.js", hash: srcHash }]);
    const tree2Hash = repo.createTree([
      { mode: "100644", name: "README.md", hash: readmeV2Hash },
      { mode: "040000", name: "src", hash: srcTreeHash },
    ]);
    const commit2Hash = repo.createCommit(tree2Hash, [commit1Hash], "Add source code", testAuthor);
    repo.updateRef("refs/heads/main", commit2Hash);

    const logOutput = gitLog(tempDir, "%H %s");
    expect(logOutput).toContain(commit2Hash);
    expect(logOutput).toContain("Add source code");
    expect(logOutput).toContain(commit1Hash);
    expect(logOutput).toContain("Initial commit");

    const fsckOutput = gitFsck(tempDir);
    expect(fsckOutput).not.toContain("error");
    expect(fsckOutput).not.toContain("broken");

    expect(gitCatFileType(tempDir, commit2Hash)).toBe("commit");
    expect(gitCatFileType(tempDir, tree2Hash)).toBe("tree");
    expect(gitCatFileType(tempDir, srcTreeHash)).toBe("tree");
    expect(gitCatFileType(tempDir, readmeV2Hash)).toBe("blob");
    expect(gitCatFileType(tempDir, srcHash)).toBe("blob");
  });

  test("git 创建的完整仓库能被 nano-git 正确读取", () => {
    gitInit(tempDir);

    createFile(tempDir, "hello.txt", "Hello from git!\n");

    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: FIXED_AUTHOR.name,
      GIT_AUTHOR_EMAIL: FIXED_AUTHOR.email,
      GIT_AUTHOR_DATE: `${FIXED_AUTHOR.timestamp} ${FIXED_AUTHOR.timezone}`,
      GIT_COMMITTER_NAME: FIXED_AUTHOR.name,
      GIT_COMMITTER_EMAIL: FIXED_AUTHOR.email,
      GIT_COMMITTER_DATE: `${FIXED_AUTHOR.timestamp} ${FIXED_AUTHOR.timezone}`,
      GIT_CONFIG_NOSYSTEM: "1",
    };

    spawnSync("git", ["add", "hello.txt"], { cwd: tempDir, env: gitEnv });
    spawnSync("git", ["commit", "-m", "Add hello.txt"], { cwd: tempDir, env: gitEnv });

    const repo = openRepository(join(tempDir, ".git"));

    const headHash = repo.readRef("HEAD");
    expect(headHash).not.toBeNull();

    const commit = repo.catFile(headHash!);
    expect(commit.type).toBe("commit");
    if (commit.type === "commit") {
      expect(commit.message).toContain("Add hello.txt");
      expect(commit.parents).toHaveLength(0);

      const tree = repo.catFile(commit.tree);
      expect(tree.type).toBe("tree");
      if (tree.type === "tree") {
        const helloEntry = tree.entries.find((e) => e.name === "hello.txt");
        expect(helloEntry).toBeDefined();
        expect(helloEntry!.mode).toBe("100644");

        const blob = repo.catFile(helloEntry!.hash);
        expect(blob.type).toBe("blob");
        if (blob.type === "blob") {
          expect(blob.content.toString("utf-8")).toBe("Hello from git!\n");
        }
      }
    }
  });

  test("nano-git 和 git 交替操作能保持仓库一致性", () => {
    gitInit(tempDir);
    const repo = openRepository(join(tempDir, ".git"));

    const file1Hash = repo.writeBlob(Buffer.from("version 1\n"));
    const tree1Hash = repo.createTree([{ mode: "100644", name: "data.txt", hash: file1Hash }]);
    const commit1Hash = repo.createCommit(tree1Hash, [], "nano-git: first commit", testAuthor);
    repo.updateRef("refs/heads/main", commit1Hash);

    createFile(tempDir, "data.txt", "version 2\n");
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: FIXED_AUTHOR.name,
      GIT_AUTHOR_EMAIL: FIXED_AUTHOR.email,
      GIT_AUTHOR_DATE: `${FIXED_AUTHOR.timestamp} ${FIXED_AUTHOR.timezone}`,
      GIT_COMMITTER_NAME: FIXED_AUTHOR.name,
      GIT_COMMITTER_EMAIL: FIXED_AUTHOR.email,
      GIT_COMMITTER_DATE: `${FIXED_AUTHOR.timestamp} ${FIXED_AUTHOR.timezone}`,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    spawnSync("git", ["add", "data.txt"], { cwd: tempDir, env: gitEnv });
    spawnSync("git", ["commit", "-m", "git: second commit"], { cwd: tempDir, env: gitEnv });

    const headHash = repo.readRef("HEAD");
    expect(headHash).not.toBeNull();

    const gitCommit = repo.catFile(headHash!);
    expect(gitCommit.type).toBe("commit");
    if (gitCommit.type === "commit") {
      expect(gitCommit.message).toContain("git: second commit");
      expect(gitCommit.parents).toHaveLength(1);
      expect(gitCommit.parents[0]).toBe(commit1Hash);
    }

    const fsckOutput = gitFsck(tempDir);
    expect(fsckOutput).not.toContain("error");
    expect(fsckOutput).not.toContain("broken");
  });

  test("nano-git gc 后仓库仍能被 git 正常读取", () => {
    const repo = initRepository(tempDir);
    const blobHash = repo.writeBlob(Buffer.from("tracked"));
    const treeHash = repo.createTree([{ mode: "100644", name: "tracked.txt", hash: blobHash }]);
    const commitHash = repo.createCommit(treeHash, [], "keep", testAuthor);
    repo.updateRef("refs/heads/main", commitHash);

    repo.writeBlob(Buffer.from("dangling"));
    repo.gc();

    expect(gitRevParse(tempDir, "HEAD")).toBe(commitHash);
    expect(gitCatFile(tempDir, blobHash)).toBe("tracked");

    const fsckOutput = gitFsck(tempDir);
    expect(fsckOutput).not.toContain("error");
    expect(fsckOutput).not.toContain("broken");
  });

  test("git gc 后的仓库仍能被 nano-git 读取，可达性与 refs 一致", () => {
    gitInit(tempDir);
    createFile(tempDir, "keep.txt", "keep");
    git(["add", "keep.txt"], tempDir);
    git(["commit", "-m", "keep"], tempDir);
    gitHashObjectWrite(tempDir, "dangling");
    gitGc(tempDir, true);

    const repo = openRepository(join(tempDir, ".git"));
    const reachable = repo.listReachableObjects();
    const headHash = gitRevParse(tempDir, "HEAD");

    expect(reachable).toContain(headHash);
    expect(repo.readRef("HEAD")).toBe(headHash);
  });
});
