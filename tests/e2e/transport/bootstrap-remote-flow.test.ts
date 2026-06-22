/**
 * Bootstrap remote 流程测试（仓库层 E2E）
 *
 * 验证 bootstrapRemote() 的完整 clone 语义：
 * - 创建 remote-tracking refs
 * - 创建本地 branch
 * - 设置 HEAD
 * - 远端默认分支正确采用
 * - 远端无默认分支时失败
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { git, gitInit, createTempDir, cleanupDir, createFile, FIXED_AUTHOR } from "../helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { sha1 } from "@/core/types.ts";
import { initRepository } from "@/repository/index.ts";
import { RemoteError } from "@/repository/remote-operations.ts";

describe("bootstrap remote 流程", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  function createRepoAndAddRemote(name: string): ReturnType<typeof initRepository> {
    const localDir = join(tempDir, name);
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });
    return repo;
  }

  beforeEach(() => {
    tempDir = createTempDir("e2e-bootstrap");

    // 创建服务端裸仓库（默认分支为 main）
    serverRepoDir = join(tempDir, "server.git");
    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);

    workDir = join(tempDir, "work");
    gitInit(workDir);
    createFile(workDir, "README.md", "# Hello\n");
    git(["add", "README.md"], workDir);
    git(["commit", "-m", "Initial commit"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    createFile(workDir, "src/lib.js", "module.exports = {}\n");
    git(["add", "src/lib.js"], workDir);
    git(["commit", "-m", "Add lib"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("bootstrap 空仓库后应创建 remote-tracking refs、本地 branch 和 HEAD", async () => {
    const repo = createRepoAndAddRemote("local-bootstrap");

    const result = await repo.bootstrapRemote("origin");

    // 对象已拉取
    expect(result.fetchedObjects).toBeGreaterThan(0);
    expect(result.defaultBranch).toBe("refs/heads/main");

    // remote-tracking refs 已创建
    const remoteMain = repo.refs.read("refs/remotes/origin/main");
    expect(remoteMain).not.toBeNull();

    // 本地 branch 已创建（采用远端默认分支名）
    const localMain = repo.refs.read("refs/heads/main");
    expect(localMain).toBe(remoteMain);

    // HEAD 已设置
    expect(repo.refs.read("HEAD")).toBe("ref: refs/heads/main");
  });

  test("bootstrap 后创建了正确的本地分支名（explicit branch）", async () => {
    const repo = createRepoAndAddRemote("local-explicit-branch");

    const result = await repo.bootstrapRemote("origin", { branch: "develop" });

    // remote-tracking refs
    const remoteMain = repo.refs.read("refs/remotes/origin/main");
    expect(remoteMain).not.toBeNull();

    // 本地分支使用显式指定的名称
    const localDevelop = repo.refs.read("refs/heads/develop");
    expect(localDevelop).toBe(remoteMain);

    // HEAD 指向指定的分支
    expect(repo.refs.read("HEAD")).toBe("ref: refs/heads/develop");

    // 远端默认分支名仍在结果中
    expect(result.defaultBranch).toBe("refs/heads/main");
    expect(result.localBranch).toBe("refs/heads/develop");
  });

  test("bootstrap 后本地 commit 对象可用", async () => {
    const repo = createRepoAndAddRemote("local-object-check");

    const result = await repo.bootstrapRemote("origin");

    expect(result.fetchedObjects).toBeGreaterThan(0);

    const mainHash = repo.refs.read("refs/heads/main");
    const commitObj = repo.objects.read(sha1(mainHash!));
    expect(commitObj.type).toBe("commit");
  });
});

// ============================================================================
// 默认分支为 develop 的场景
// ============================================================================

describe("bootstrap remote 默认分支处理", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-bootstrap-default-branch");

    // 创建服务端裸仓库，推送 develop 分支
    serverRepoDir = join(tempDir, "server.git");
    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);

    const workDir = join(tempDir, "work");
    gitInit(workDir);
    // checkout -b develop 创建本地 develop 分支
    git(["checkout", "-b", "develop"], workDir);
    createFile(workDir, "README.md", "# Develop branch\n");
    git(["add", "README.md"], workDir);
    git(["commit", "-m", "Initial commit on develop"], workDir);
    git(["push", serverRepoDir, "develop"], workDir);
    // 设置 HEAD 指向 develop
    git(["--git-dir", serverRepoDir, "symbolic-ref", "HEAD", "refs/heads/develop"], tempDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("远端默认分支为 develop 时 bootstrap 应正确采用", async () => {
    const localDir = join(tempDir, "local-develop");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    const result = await repo.bootstrapRemote("origin");

    expect(result.defaultBranch).toBe("refs/heads/develop");

    // remote-tracking ref
    const remoteDevelop = repo.refs.read("refs/remotes/origin/develop");
    expect(remoteDevelop).not.toBeNull();

    // 本地分支应为 develop
    const localDevelop = repo.refs.read("refs/heads/develop");
    expect(localDevelop).toBe(remoteDevelop);

    // HEAD 指向 develop
    expect(repo.refs.read("HEAD")).toBe("ref: refs/heads/develop");

    // main 分支不应被创建
    expect(repo.refs.read("refs/heads/main")).toBeNull();
  });
});

// ============================================================================
// 错误场景
// ============================================================================

describe("bootstrap remote 错误处理", () => {
  let tempDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-bootstrap-error");

    // 创建一个没有默认分支的远端（只有 tag，没有 heads）
    const serverRepoDir = join(tempDir, "server.git");
    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);

    const workDir = join(tempDir, "work");
    gitInit(workDir);
    createFile(workDir, "README.md", "# Hello\n");
    git(["add", "README.md"], workDir);
    git(["commit", "-m", "Initial commit"], workDir);
    // push 但不留 branch（创建 tag 后删除 branch）
    git(["push", serverRepoDir, "main"], workDir);
    git(["tag", "-a", "v1.0", "-m", "release"], workDir);
    git(["push", serverRepoDir, "refs/tags/v1.0"], workDir);
    git(["--git-dir", serverRepoDir, "update-ref", "-d", "refs/heads/main"], tempDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("远端无任何 branch 时 bootstrap 应失败", async () => {
    const localDir = join(tempDir, "local-no-default");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    // 远端无 HEAD/默认分支，bootstrap 应报错
    const bootstrapPromise = repo.bootstrapRemote("origin");
    expect(bootstrapPromise).rejects.toThrow(/default branch/i);
  });

  test("配置的 remote 不存在时 bootstrap 应失败", async () => {
    const localDir = join(tempDir, "local-no-remote");
    const repo = initRepository(localDir);

    const bootstrapPromise = repo.bootstrapRemote("nonexistent");
    expect(bootstrapPromise).rejects.toThrow(/not found/i);
  });

  test("默认 branch tracking ref 被拒绝时 bootstrap 应报错", async () => {
    // 场景：fetchRules 为 refs/heads/*:refs/heads/*（无 force），
    // 本地已有不同的 refs/heads/main，导致 fetch 阶段 rejected
    const localDir = join(tempDir, "local-rejected-default");
    const repo = initRepository(localDir);

    // 创建一个不同的 HEAD commit，使本地与远端不兼容
    const author = { ...FIXED_AUTHOR };
    const fileHash = repo.writeBlob(Buffer.from("different initial commit"));
    const treeHash = repo.createTree([{ mode: "100644", name: "init.txt", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Different initial", author);
    repo.updateRef("refs/heads/main", commitHash);

    repo.addRemote({
      name: "origin",
      url: serverUrl,
      // 非 force 的 refs/heads/* → refs/heads/* 映射
      fetchRules: [{ source: "refs/heads/*", target: "refs/heads/*" }],
    });

    expect(repo.bootstrapRemote("origin")).rejects.toBeInstanceOf(RemoteError);
  });
});
