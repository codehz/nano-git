/**
 * Fetch remote 流程测试（仓库层 E2E）
 *
 * 验证 fetchRemote（及兼容 fetch）的 remote-tracking ref 更新行为：
 * - 创建 refs/remotes/origin/*
 * - 增量 fetch 无重复对象
 * - tag 处理、精确 refspec、空仓库
 * - 不修改 HEAD，不创建本地 branch
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { git, gitInit, createTempDir, cleanupDir, createFile } from "../helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { sha1 } from "@/core/types.ts";
import { initRepository } from "@/repository/index.ts";

describe("fetch remote 流程", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-fetch-remote");

    // 1. 创建服务端裸仓库
    serverRepoDir = join(tempDir, "server.git");
    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);

    // 2. 创建并推送提交
    workDir = join(tempDir, "work");
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

    // 3. 启动 HTTP 服务器
    server = startGitHttpBackendServer(tempDir, "/server.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("初始 fetch 创建 remote-tracking refs", async () => {
    const localDir = join(tempDir, "local");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    const result = await repo.fetchRemote("origin");

    expect(result.transfer.objectCount).toBeGreaterThan(0);

    const mainRef = repo.refs.read("refs/remotes/origin/main");
    expect(mainRef).not.toBeNull();
    expect(mainRef!.length).toBe(40);

    // 不 assert HEAD 的具体值——transport 层不再写 HEAD

    const commitObj = repo.objects.read(sha1(mainRef!));
    expect(commitObj.type).toBe("commit");
  });

  test("增量 fetch：已存在对象时不重复拉取", async () => {
    const localDir = join(tempDir, "local2");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    const result1 = await repo.fetchRemote("origin");
    expect(result1.transfer.objectCount).toBeGreaterThan(0);

    const result2 = await repo.fetchRemote("origin");
    expect(result2.transfer.objectCount).toBe(0);
    expect(result2.refUpdates.updatedRefs.size).toBe(0);
  });

  test("增量 fetch：本地通过其他 ref 持有目标 commit 时不重复下载", async () => {
    const localDir = join(tempDir, "local-multi-ref");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    // 1. 初始 fetch
    const result1 = await repo.fetchRemote("origin");
    expect(result1.transfer.objectCount).toBeGreaterThan(0);

    // 2. 创建 feature 分支并推送
    const featureDir = join(tempDir, "work-feature");
    git(["clone", serverRepoDir, featureDir], tempDir);
    createFile(featureDir, "feature.txt", "feature content\n");
    git(["add", "feature.txt"], featureDir);
    git(["commit", "-m", "Feature commit"], featureDir);
    const featureHash = git(["rev-parse", "HEAD"], featureDir);
    git(["push", serverRepoDir, `HEAD:feature`], featureDir);

    // 3. 第二次 fetch
    const result2 = await repo.fetchRemote("origin");
    expect(result2.refUpdates.updatedRefs.has("refs/remotes/origin/feature")).toBe(true);

    // 4. 服务端将 main 快进到 feature commit
    git(["update-ref", "refs/heads/main", featureHash], serverRepoDir);

    // 5. 第三次 fetch：main 已前进到 feature commit，但该 commit 已在本地
    const result3 = await repo.fetchRemote("origin");
    expect(result3.transfer.objectCount).toBe(0);
    expect(result3.refUpdates.updatedRefs.get("refs/remotes/origin/main")).toBe(sha1(featureHash));
  });

  test("空仓库 fetch：返回空结果且不写入 remote-tracking refs", async () => {
    const emptyRepoDir = join(tempDir, "empty-fetch.git");
    mkdirSync(emptyRepoDir);
    git(["init", "--bare"], emptyRepoDir);

    await using emptyServer = startGitHttpBackendServer(tempDir, "/empty-fetch.git");

    const localDir = join(tempDir, "local-empty-fetch");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "empty",
      url: emptyServer.url,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });
    const result = await repo.fetchRemote("empty");

    expect(result.transfer.objectCount).toBe(0);
    expect(result.refUpdates.updatedRefs.size).toBe(0);
    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();
  });
});

// ============================================================================
// Tag 相关测试
// ============================================================================

describe("fetch remote tag 处理", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-fetch-tag");

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

  test("显式 tag refspec：fetch 注解 tag 到本地 tags 命名空间", async () => {
    git(["tag", "-a", "v1.0", "-m", "release v1.0"], workDir);
    git(["push", serverRepoDir, "refs/tags/v1.0"], workDir);

    const localDir = join(tempDir, "local-tag-fetch");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/tags/*", target: "refs/tags/*" }],
    });

    const result = await repo.fetchRemote("origin");

    expect(result.transfer.objectCount).toBeGreaterThan(0);
    const tagHash = repo.refs.read("refs/tags/v1.0");
    expect(tagHash).not.toBeNull();
    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();

    const tagObject = repo.objects.read(sha1(tagHash!));
    expect(tagObject.type).toBe("tag");
  });

  test("include-tag：默认 branch fetch 会顺带获取注解 tag 对象，但不会创建 tag ref", async () => {
    git(["tag", "-a", "v-include", "-m", "include tag"], workDir);
    git(["push", serverRepoDir, "refs/tags/v-include"], workDir);
    const remoteTagHash = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/tags/v-include"],
      tempDir,
    );

    const localDir = join(tempDir, "local-include-tag");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });
    const result = await repo.fetchRemote("origin");

    expect(result.transfer.objectCount).toBeGreaterThan(0);
    expect(repo.refs.read("refs/remotes/origin/main")).not.toBeNull();
    expect(repo.refs.read("refs/tags/v-include")).toBeNull();
    expect(repo.objects.exists(sha1(remoteTagHash))).toBe(true);
    expect(repo.objects.read(sha1(remoteTagHash)).type).toBe("tag");
  });

  test("精确 refspec：混合 branches/tags 广告时只抓取指定 branch 与 tag", async () => {
    const featureDir = join(tempDir, "work-mixed-feature");
    git(["clone", serverRepoDir, featureDir], tempDir);
    createFile(featureDir, "feature.txt", "feature branch\n");
    git(["add", "feature.txt"], featureDir);
    git(["commit", "-m", "Feature branch commit"], featureDir);
    git(["push", serverRepoDir, "HEAD:refs/heads/feature"], featureDir);

    createFile(workDir, "main-second.txt", "main second\n");
    git(["add", "main-second.txt"], workDir);
    git(["commit", "-m", "Main second"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["tag", "-a", "v-main-only", "-m", "main tag"], workDir);
    git(["push", serverRepoDir, "refs/tags/v-main-only"], workDir);

    git(["tag", "-a", "v-feature", "-m", "feature tag"], featureDir);
    git(["push", serverRepoDir, "refs/tags/v-feature"], featureDir);

    const localDir = join(tempDir, "local-exact-refspec-mixed");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [
        { source: "+refs/heads/main", target: "refs/remotes/origin/main" },
        { source: "+refs/tags/v-main-only", target: "refs/tags/v-main-only" },
      ],
    });
    const result = await repo.fetchRemote("origin");

    expect(result.transfer.objectCount).toBeGreaterThan(0);
    expect(repo.refs.read("refs/remotes/origin/main")).not.toBeNull();
    expect(repo.refs.read("refs/remotes/origin/feature")).toBeNull();
    expect(repo.refs.read("refs/tags/v-main-only")).not.toBeNull();
    expect(repo.refs.read("refs/tags/v-feature")).toBeNull();
  });

  test("tag-only 远端：默认 refspec fetch 返回空结果", async () => {
    git(["tag", "-a", "v-tag-only", "-m", "tag only"], workDir);
    git(["push", serverRepoDir, "refs/tags/v-tag-only"], workDir);
    git(["--git-dir", serverRepoDir, "update-ref", "-d", "refs/heads/main"], tempDir);

    const localDir = join(tempDir, "local-tag-only-default");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });
    const result = await repo.fetchRemote("origin");

    expect(result.transfer.objectCount).toBe(0);
    expect(result.refUpdates.updatedRefs.size).toBe(0);
    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();
    expect(repo.refs.read("refs/tags/v-tag-only")).toBeNull();
  });

  test("tag-only 远端：显式 tag refspec 仍可 fetch 注解 tag", async () => {
    git(["tag", "-a", "v-tag-only-fetch", "-m", "tag only fetch"], workDir);
    git(["push", serverRepoDir, "refs/tags/v-tag-only-fetch"], workDir);
    git(["--git-dir", serverRepoDir, "update-ref", "-d", "refs/heads/main"], tempDir);

    const localDir = join(tempDir, "local-tag-only-explicit");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/tags/*", target: "refs/tags/*" }],
    });
    const result = await repo.fetchRemote("origin");

    expect(result.transfer.objectCount).toBeGreaterThan(0);
    const tagHash = repo.refs.read("refs/tags/v-tag-only-fetch");
    expect(tagHash).not.toBeNull();
    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();
    expect(repo.objects.read(sha1(tagHash!)).type).toBe("tag");
  });

  test("annotated tag fetch 到 refs/heads/* 时失败，且不写入本地 branch ref", async () => {
    git(["tag", "-a", "v-branch-invalid", "-m", "branch invalid tag"], workDir);
    git(["push", serverRepoDir, "refs/tags/v-branch-invalid"], workDir);

    const localDir = join(tempDir, "local-invalid-branch-target");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/tags/v-branch-invalid", target: "refs/heads/from-tag" }],
    });

    const fetchPromise = repo.fetchRemote("origin");

    expect(fetchPromise).rejects.toThrow(/tag object|expected commit|refs\/heads/i);
    expect(repo.refs.read("refs/heads/from-tag")).toBeNull();
  });

  test("非强制 fetch 更新已有 lightweight tag 应被拒绝（但 force 可以）", async () => {
    // 1. 在服务端创建 lightweight tag
    const initialCommit = git(["rev-parse", "HEAD"], workDir);
    git(["tag", "-f", "v-update", initialCommit], workDir);
    git(["push", serverRepoDir, "refs/tags/v-update"], workDir);

    // 2. 用 + 先在本地创建 lightweight tag
    const localDir = join(tempDir, "local-tag-update");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "tag-force",
      url: serverUrl,
      fetchRules: [{ source: "+refs/tags/*", target: "refs/tags/*" }],
    });
    const firstResult = await repo.fetchRemote("tag-force");
    expect(firstResult.refUpdates.updatedRefs.has("refs/tags/v-update")).toBe(true);

    // 3. 创建新的 commit 并推送到服务端
    createFile(workDir, "new-tag-file.txt", "new content\n");
    git(["add", "new-tag-file.txt"], workDir);
    git(["commit", "-m", "New commit for tag update"], workDir);
    git(["push", serverRepoDir, "main"], workDir);
    const newCommit = git(["rev-parse", "HEAD"], workDir);
    git(["--git-dir", serverRepoDir, "tag", "-f", "v-update", newCommit], tempDir);

    // 4. 非强制 fetch——应拒绝更新已有 tag
    repo.addRemote({
      name: "tag-noforce",
      url: serverUrl,
      fetchRules: [{ source: "refs/tags/*", target: "refs/tags/*", force: false }],
    });
    const secondResult = await repo.fetchRemote("tag-noforce");
    const localTagHash = repo.refs.read("refs/tags/v-update");
    expect(localTagHash).toBe(initialCommit);
    expect(secondResult.refUpdates.updatedRefs.has("refs/tags/v-update")).toBe(false);

    // 5. 强制 fetch——应更新 tag
    repo.addRemote({
      name: "tag-force2",
      url: serverUrl,
      fetchRules: [{ source: "+refs/tags/*", target: "refs/tags/*" }],
    });
    const thirdResult = await repo.fetchRemote("tag-force2");
    const updatedTagHash = repo.refs.read("refs/tags/v-update");
    expect(updatedTagHash).toBe(newCommit);
    expect(thirdResult.refUpdates.updatedRefs.get("refs/tags/v-update")).toBe(sha1(newCommit));
  });
});
