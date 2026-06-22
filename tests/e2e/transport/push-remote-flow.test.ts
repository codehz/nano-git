/**
 * Push remote 流程测试（仓库层 E2E）
 *
 * 验证 pushRemote() 的主语义行为：
 * - 使用 remote.pushRefSpecs 作为默认 refspec
 * - 使用 remote.pushUrl 作为默认目标地址
 * - options.pushUrl 覆盖 remote.pushUrl
 * - options.refSpecs 覆盖 remote.pushRefSpecs
 * - remote 不存在时抛 RemoteError
 *
 * 不同于 transport/push.test.ts 专注于协议行为，
 * 此处专注于 repository 层的 remote 配置决策路径。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { git, gitInit, createTempDir, cleanupDir, createFile, FIXED_AUTHOR } from "../helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { createMemoryRepositoryBackend } from "@/repository/backend/memory-backend.ts";
import { createRepository } from "@/repository/index.ts";
import { RemoteError } from "@/repository/remote-operations.ts";

// ============================================================================
// 辅助函数
// ============================================================================

function enableReceivePack(repoDir: string): void {
  const configPath = join(repoDir, "config");
  const config = readFileSync(configPath, "utf-8");
  if (!config.includes("http.receivepack")) {
    writeFileSync(configPath, config + "\n[http]\n\treceivepack = true\n");
  }
}

// ============================================================================
// 测试
// ============================================================================

describe("pushRemote() 主路径", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-push-remote");

    // 1. 创建主服务端裸仓库
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
    server = startGitHttpBackendServer(tempDir, "/server.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("pushRemote 使用 remote.pushRefSpecs 作为默认 refspec", async () => {
    const repo = createRepository(
      createMemoryRepositoryBackend({
        initialRemotes: [
          {
            name: "origin",
            url: serverUrl,
            fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
            pushRefSpecs: ["+refs/heads/main:refs/heads/main"],
          },
        ],
      }),
    );

    const author = { ...FIXED_AUTHOR };
    const fileHash = repo.writeBlob(Buffer.from("push via remote refspec"));
    const treeHash = repo.createTree([{ mode: "100644", name: "README.md", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Push via remote refspec", author);
    repo.updateRef("refs/heads/main", commitHash);

    // 不传 refSpecs，依赖 remote.pushRefSpecs
    const result = await repo.pushRemote("origin");

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.pushedRefs[0]!.refName).toBe("refs/heads/main");

    const serverRef = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/main"], tempDir);
    expect(serverRef).toBe(commitHash);
  });

  test("pushRemote 使用 remote.pushUrl 作为默认目标地址", async () => {
    // 创建替代服务端
    const altRepoDir = join(tempDir, "alt.git");
    mkdirSync(altRepoDir);
    git(["init", "--bare"], altRepoDir);
    enableReceivePack(altRepoDir);
    const altServer = startGitHttpBackendServer(tempDir, "/alt.git");

    const repo = createRepository(
      createMemoryRepositoryBackend({
        initialRemotes: [
          {
            name: "origin",
            url: serverUrl,
            pushUrl: altServer.url,
            fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
            pushRefSpecs: ["+refs/heads/main:refs/heads/main"],
          },
        ],
      }),
    );

    const author = { ...FIXED_AUTHOR };
    const fileHash = repo.writeBlob(Buffer.from("push via pushUrl"));
    const treeHash = repo.createTree([{ mode: "100644", name: "README.md", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Push via pushUrl", author);
    repo.updateRef("refs/heads/main", commitHash);

    const result = await repo.pushRemote("origin");

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);

    // pushUrl 仓库应有新 commit，url 仓库仍只有初始 commit
    const serverRefCount = git(
      ["--git-dir", serverRepoDir, "rev-list", "--all", "--count"],
      tempDir,
    );
    expect(serverRefCount).toBe("1");

    const altRefCount = git(["--git-dir", altRepoDir, "rev-list", "--all", "--count"], tempDir);
    // Alt 仓库原本为空，收到 1 个新 commit
    expect(altRefCount).toBe("1");

    await altServer.stop();
  });

  test("options.pushUrl 覆盖 remote.pushUrl", async () => {
    const altRepoDir = join(tempDir, "override.git");
    mkdirSync(altRepoDir);
    git(["init", "--bare"], altRepoDir);
    enableReceivePack(altRepoDir);
    const altServer = startGitHttpBackendServer(tempDir, "/override.git");

    const repo = createRepository(
      createMemoryRepositoryBackend({
        initialRemotes: [
          {
            name: "origin",
            url: serverUrl,
            pushUrl: serverUrl,
            fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
            pushRefSpecs: ["+refs/heads/main:refs/heads/main"],
          },
        ],
      }),
    );

    const author = { ...FIXED_AUTHOR };
    const fileHash = repo.writeBlob(Buffer.from("push via override pushUrl"));
    const treeHash = repo.createTree([{ mode: "100644", name: "README.md", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Push via override pushUrl", author);
    repo.updateRef("refs/heads/main", commitHash);

    // 使用 options.pushUrl 覆盖
    const result = await repo.pushRemote("origin", { pushUrl: altServer.url });

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);

    await altServer.stop();
  });

  test("options.refSpecs 覆盖 remote.pushRefSpecs", async () => {
    const repo = createRepository(
      createMemoryRepositoryBackend({
        initialRemotes: [
          {
            name: "origin",
            url: serverUrl,
            fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
            // 默认上去 develop，但 options.refSpecs 应覆盖
            pushRefSpecs: ["+refs/heads/develop:refs/heads/develop"],
          },
        ],
      }),
    );

    const author = { ...FIXED_AUTHOR };
    const fileHash = repo.writeBlob(Buffer.from("push via explicit refspec"));
    const treeHash = repo.createTree([{ mode: "100644", name: "README.md", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Push via explicit refspec", author);
    repo.updateRef("refs/heads/main", commitHash);

    // 用显式 refSpecs 覆盖 remote.pushRefSpecs
    const result = await repo.pushRemote("origin", {
      refSpecs: ["+refs/heads/main:refs/heads/main"],
    });

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.pushedRefs[0]!.refName).toBe("refs/heads/main");
  });

  test("remote 不存在时抛 RemoteError", async () => {
    const repo = createRepository(createMemoryRepositoryBackend());

    expect(repo.pushRemote("nonexistent")).rejects.toThrow(RemoteError);
  });

  test("pushRemote 返回结果包含 pushedRefs 和 objectCount", async () => {
    const repo = createRepository(
      createMemoryRepositoryBackend({
        initialRemotes: [
          {
            name: "origin",
            url: serverUrl,
            fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
            pushRefSpecs: ["+refs/heads/main:refs/heads/main"],
          },
        ],
      }),
    );

    const author = { ...FIXED_AUTHOR };
    const fileHash = repo.writeBlob(Buffer.from("verify result fields"));
    const treeHash = repo.createTree([{ mode: "100644", name: "README.md", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Verify result fields", author);
    repo.updateRef("refs/heads/main", commitHash);

    const result = await repo.pushRemote("origin");

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.objectCount).toBeGreaterThan(0);
    expect(result.progress).toBeDefined();
  });
});
