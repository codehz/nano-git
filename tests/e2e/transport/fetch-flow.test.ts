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
import { sha1 } from "@/core/types.ts";
import { initRepository } from "@/repository/index.ts";

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

  test("增量 fetch：本地通过其他 ref 持有目标 commit 时不重复下载", async () => {
    const localDir = join(tempDir, "local-multi-ref");
    const repo = initRepository(localDir);

    // 1. 初始 fetch：获取 main 的 2 个提交
    const result1 = await repo.fetch(serverUrl);
    expect(result1.objectCount).toBeGreaterThan(0);

    const oldMainHash = repo.refs.readRaw("refs/remotes/origin/main")!;

    // 2. 在服务端创建 feature 分支并推一个新提交
    const workDir = join(tempDir, "work-feature");
    git(["clone", serverRepoDir, workDir], tempDir);
    createFile(workDir, "feature.txt", "feature content\n");
    git(["add", "feature.txt"], workDir);
    git(["commit", "-m", "Feature commit"], workDir);
    const featureHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, `HEAD:feature`], workDir);

    // 3. 第二次 fetch：获取 feature 分支到本地
    const result2 = await repo.fetch(serverUrl);
    expect(result2.fetchedRefs.has("refs/remotes/origin/feature")).toBe(true);
    expect(repo.refs.readRaw("refs/remotes/origin/feature")).toBe(featureHash);
    expect(repo.refs.readRaw("refs/remotes/origin/main")).toBe(oldMainHash);

    // 4. 服务端将 main 快进到 feature 指向的同一个 commit
    git(["update-ref", "refs/heads/main", featureHash], serverRepoDir);

    // 5. 第三次 fetch：main 已前进到 feature commit，但该 commit 已在本地存储中
    const result3 = await repo.fetch(serverUrl);

    // BUG: 由于 have 列表只用了旧 refs/remotes/origin/main 而非所有本地 ref，
    //      导致 collectHaveCommits 没有遍历到 feature commit，
    //      服务端仍会重新发送 feature commit 的所有对象。
    // 修复后应为 0。
    expect(result3.objectCount).toBe(0);
    expect(result3.fetchedRefs.get("refs/remotes/origin/main")).toBe(sha1(featureHash));
  });

  test("空仓库 fetch：返回空结果且不写入 remote-tracking refs", async () => {
    const emptyRepoDir = join(tempDir, "empty-fetch.git");
    mkdirSync(emptyRepoDir);
    git(["init", "--bare"], emptyRepoDir);

    await using emptyServer = startGitHttpBackendServer(tempDir, "/empty-fetch.git");

    const localDir = join(tempDir, "local-empty-fetch");
    const repo = initRepository(localDir);
    const result = await repo.fetch(emptyServer.url);

    expect(result.objectCount).toBe(0);
    expect(result.fetchedRefs.size).toBe(0);
    expect(repo.refs.readRaw("refs/remotes/origin/main")).toBeNull();
  });
});
