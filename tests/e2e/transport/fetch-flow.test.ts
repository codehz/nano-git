/**
 * 完整 Fetch 流程测试
 *
 * 验证从零 clone、增量 fetch、shallow fetch 等完整 fetch 场景。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { git, gitInit, createTempDir, cleanupDir, createFile } from "../helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";

import { sha1 } from "../../../src/core/types.ts";
import { initRepository } from "../../../src/repository/index.ts";

describe("完整 fetch 流程", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-full-fetch");

    // 1. 创建服务端裸仓库
    serverRepoDir = join(tempDir, "server.git");
    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);

    // 2. 创建并推送提交
    const workDir = join(tempDir, "work");
    gitInit(workDir);
    createFile(workDir, "README.md", "# Hello\n");
    createFile(workDir, "src/index.js", 'console.log("hello");\n');
    git(["add", "README.md", "src/index.js"], workDir);
    git(["commit", "-m", "Initial commit"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    // 创建第二个提交
    createFile(workDir, "src/lib.js", "module.exports = {}\n");
    git(["add", "src/lib.js"], workDir);
    git(["commit", "-m", "Add lib"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    // 3. 启动 HTTP 服务器代理 git http-backend
    server = startGitHttpBackendServer(tempDir, "/server.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("初始 clone", async () => {
    const localDir = join(tempDir, "local");
    const repo = initRepository(localDir);

    const result = await repo.fetch(serverUrl);

    expect(result.objectCount).toBeGreaterThan(0);

    const mainRef = repo.refs.readRaw("refs/remotes/origin/main");
    expect(mainRef).not.toBeNull();
    expect(mainRef!.length).toBe(40);

    const headRef = repo.refs.readRaw("HEAD");
    expect(headRef).not.toBeNull();

    const commitObj = repo.objects.read(sha1(mainRef!));
    expect(commitObj.type).toBe("commit");
  });

  test("增量 fetch：已存在对象时不重复拉取", async () => {
    const localDir = join(tempDir, "local2");
    const repo = initRepository(localDir);

    const result1 = await repo.fetch(serverUrl);
    expect(result1.objectCount).toBeGreaterThan(0);

    const result2 = await repo.fetch(serverUrl);
    expect(result2.objectCount).toBe(0);
    expect(result2.fetchedRefs.size).toBe(0);
  });

  test("shallow fetch：depth=1 应成功完成初始拉取", async () => {
    const localDir = join(tempDir, "local-shallow");
    const repo = initRepository(localDir);

    const result = await repo.fetch(serverUrl, { depth: 1 });

    expect(result.objectCount).toBeGreaterThan(0);
    expect(repo.refs.readRaw("refs/remotes/origin/main")).not.toBeNull();
  });
});
