/**
 * Push 高层 API 端到端测试
 *
 * 通过 HTTP 服务将 push() 的全套编排逻辑接入 git http-backend：
 *   parseRefSpec → determinePushRefs → checkFastForward → collectReachable
 *   → createPackWriter → buildReceivePackRequest → postReceivePack → parseReceivePackResult
 *
 * 不依赖手工构造协议报文，完整验证高层 push() 函数的网络路径行为。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  git,
  gitInit,
  createTempDir,
  cleanupDir,
  createFile,
  FIXED_AUTHOR,
  startGitHttpBackendServer,
} from "./helpers.ts";
import { createMemoryRepository, type Repository } from "../../src/repository/index.ts";
import { sha1 } from "../../src/core/types.ts";

// ============================================================================
// 常量
// ============================================================================

const HTTP_BACKEND = "/usr/lib/git-core/git-http-backend";

function enableReceivePack(repoDir: string): void {
  const configPath = join(repoDir, "config");
  const config = readFileSync(configPath, "utf-8");
  if (!config.includes("http.receivepack")) {
    writeFileSync(configPath, config + "\n[http]\n\treceivepack = true\n");
  }
}

function makeRepo(): Repository {
  return createMemoryRepository();
}

function makeAuthor() {
  return {
    name: FIXED_AUTHOR.name,
    email: FIXED_AUTHOR.email,
    timestamp: FIXED_AUTHOR.timestamp,
    timezone: FIXED_AUTHOR.timezone,
  };
}

// ============================================================================
// 测试
// ============================================================================

describe("push() 端到端", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-push-cgi");

    // 1. 创建服务端裸仓库
    serverRepoDir = join(tempDir, "server.git");
    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);
    enableReceivePack(serverRepoDir);

    // 2. 创建初始提交并推送到服务端作为基准
    workDir = join(tempDir, "work");
    gitInit(workDir);
    createFile(workDir, "README.md", "# Hello\n");
    git(["add", "README.md"], workDir);
    git(["commit", "-m", "Initial commit"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    // 3. 启动 HTTP 服务
    server = startGitHttpBackendServer(tempDir, "/server.git", HTTP_BACKEND);
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("推送新分支到远端", async () => {
    const repo = makeRepo();
    const author = makeAuthor();

    const fileHash = repo.writeBlob(Buffer.from("new branch content"));
    const treeHash = repo.createTree([{ mode: "100644", name: "new-branch.txt", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "New branch commit", author);
    repo.updateRef("refs/heads/new-feature", commitHash);

    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/new-feature:refs/heads/new-feature"],
    });

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
    expect(result.refUpdates[0]!.refName).toBe("refs/heads/new-feature");

    const serverRef = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/heads/new-feature"],
      tempDir,
    );
    expect(serverRef).toBe(commitHash);
  });

  test("通过 push 删除远程分支", async () => {
    // 1. 先用系统 git 创建 feature 分支并推送到服务端
    createFile(workDir, "FEATURE.md", "# Feature\n");
    git(["add", "FEATURE.md"], workDir);
    git(["commit", "-m", "Feature commit"], workDir);
    const branchHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "HEAD:refs/heads/feature"], workDir);

    const branchRef = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/feature"], tempDir);
    expect(branchRef).toBe(branchHash);

    // 2. 用 nano-git push 删除远程分支
    const deleteRepo = makeRepo();
    const deleteResult = await deleteRepo.push(serverUrl, {
      refSpecs: [":refs/heads/feature"],
    });

    expect(deleteResult.refUpdates).toHaveLength(1);
    expect(deleteResult.refUpdates[0]!.success).toBe(true);
    expect(deleteResult.refUpdates[0]!.refName).toBe("refs/heads/feature");

    const branchList = git(["--git-dir", serverRepoDir, "branch", "-a"], tempDir);
    expect(branchList).not.toContain("feature");
  });

  test("non-fast-forward 推送到远端被本地预检拒绝", async () => {
    const repo = makeRepo();
    const author = makeAuthor();

    // 获取服务端 refs/heads/main 的哈希，用于制造分叉
    // 注意：这个哈希在本地 store 中不存在，但 checkFastForward 中 isAncestor 使用的是本地 store
    // 所以这里我们只需确保 remoteHash 不等于 localHash 且没有祖先关系即可
    const _remoteMainHash = sha1(
      git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/main"], tempDir),
    );

    // 本地创建分叉 commit
    const fileHash = repo.writeBlob(Buffer.from("divergent"));
    const treeHash = repo.createTree([{ mode: "100644", name: "d.txt", hash: fileHash }]);
    const divergentHash = repo.createCommit(treeHash, [], "Divergent", author);
    repo.updateRef("refs/heads/main", divergentHash);

    const pushPromise = repo.push(serverUrl, {
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });

    await expect(pushPromise).rejects.toThrow("Non-fast-forward");
  });

  test("non-fast-forward 但设 force 时可以通过", async () => {
    const repo = makeRepo();
    const author = makeAuthor();

    const fileHash = repo.writeBlob(Buffer.from("forced"));
    const treeHash = repo.createTree([{ mode: "100644", name: "f.txt", hash: fileHash }]);
    const forceHash = repo.createCommit(treeHash, [], "Forced", author);
    repo.updateRef("refs/heads/main", forceHash);

    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/main:refs/heads/main"],
      force: true,
    });

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
    expect(result.refUpdates[0]!.refName).toBe("refs/heads/main");

    const serverRef = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/main"], tempDir);
    expect(serverRef).toBe(forceHash);
  });
});
