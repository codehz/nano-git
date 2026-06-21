/**
 * 传输层集成测试
 *
 * 通过 HTTP 服务器代理 git http-backend，验证 ref advertisement、
 * upload-pack（fetch）、receive-pack（push）的完整流程。
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
  startGitHttpBackendServer,
  type GitHttpRequestRecord,
} from "./helpers.ts";

import { sha1 } from "../../src/core/types.ts";
import { createSmartHttpClient } from "../../src/transport/smart-http.ts";
import { initRepository } from "../../src/repository/index.ts";
import { parsePktLines } from "../../src/transport/pkt-line.ts";

// ============================================================================
// 辅助函数
// ============================================================================

function enableReceivePack(repoDir: string): void {
  const configPath = join(repoDir, "config");
  const config = readFileSync(configPath, "utf-8");
  if (!config.includes("http.receivepack")) {
    writeFileSync(configPath, config + "\n[http]\n\treceivepack = true\n", "utf-8");
  }
}

/** 用系统 git 创建裸仓库并推送初始提交 */
function createServerRepo(
  tempDir: string,
  name: string,
  enablePush = false,
): { repoDir: string; projectRoot: string; commitHash: string; workDir: string } {
  const repoDir = join(tempDir, name);
  const projectRoot = tempDir;
  const workDir = join(tempDir, "work-" + name);

  mkdirSync(repoDir);
  git(["init", "--bare"], repoDir);
  if (enablePush) {
    enableReceivePack(repoDir);
  }

  mkdirSync(workDir);
  gitInit(workDir);
  createFile(workDir, "README.md", "# Hello\n");
  git(["add", "README.md"], workDir);
  git(["commit", "-m", "Initial commit"], workDir);
  const commitHash = git(["rev-parse", "HEAD"], workDir);
  git(["push", repoDir, "main"], workDir);

  return { repoDir, projectRoot, commitHash, workDir };
}

/**
 * 解析 upload-pack 请求中的命令文本
 */
function decodeUploadPackCommands(body: Buffer): string[] {
  return parsePktLines(body)
    .filter((line) => line.type === "data")
    .map((line) => line.payload.toString("utf-8").trimEnd());
}

/**
 * 统计 upload-pack 请求中的 flush 数量
 */
function countFlushPackets(body: Buffer): number {
  return parsePktLines(body).filter((line) => line.type === "flush").length;
}

/**
 * 过滤服务端记录到的 upload-pack POST 请求
 */
function getUploadPackRequests(requests: GitHttpRequestRecord[]): GitHttpRequestRecord[] {
  return requests.filter(
    (request) => request.method === "POST" && request.path.endsWith("/git-upload-pack"),
  );
}

// ============================================================================
// Ref Advertisement 测试
// ============================================================================

describe("ref advertisement", () => {
  let tempDir: string;
  let repoDir: string;
  let serverUrl: string;
  let commitHash: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-http-refs");
    const created = createServerRepo(tempDir, "test.git");
    repoDir = created.repoDir;
    commitHash = created.commitHash;
    server = startGitHttpBackendServer(tempDir, "/test.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("解析 ref advertisement 并验证 refs", async () => {
    const transport = createSmartHttpClient(serverUrl);
    const adv = await transport.getRefAdvertisement();

    expect(adv.refs.length).toBeGreaterThanOrEqual(1);

    const mainRef = adv.refs.find((r) => r.name === "refs/heads/main");
    expect(mainRef).toBeDefined();
    expect(mainRef!.hash).toBe(sha1(commitHash));

    expect(adv.capabilities["multi_ack"]).toBe(true);
    expect(adv.capabilities["side-band-64k"]).toBe(true);
    expect(adv.capabilities["ofs-delta"]).toBe(true);
    expect(adv.capabilities["agent"]).toMatch(/^git\//);
  });

  test("解析带多个分支的 ref advertisement", async () => {
    const branchDir = join(tempDir, "branch-work");
    gitInit(branchDir);
    createFile(branchDir, "feature.md", "# Feature\n");
    git(["add", "feature.md"], branchDir);
    git(["commit", "-m", "Feature commit"], branchDir);
    git(["push", repoDir, "HEAD:refs/heads/feature"], branchDir);

    const transport = createSmartHttpClient(serverUrl);
    const adv = await transport.getRefAdvertisement();

    const featureRef = adv.refs.find((r) => r.name === "refs/heads/feature");
    expect(featureRef).toBeDefined();
  });

  test("空仓库应返回 capabilities 但无 refs", async () => {
    const emptyDir = join(tempDir, "empty.git");
    mkdirSync(emptyDir);
    git(["init", "--bare"], emptyDir);

    const emptyServer = startGitHttpBackendServer(tempDir, "/empty.git");
    try {
      const transport = createSmartHttpClient(emptyServer.url);
      const adv = await transport.getRefAdvertisement();

      expect(adv.refs).toHaveLength(0);
      expect(Object.keys(adv.capabilities).length).toBeGreaterThan(0);
    } finally {
      await emptyServer.stop();
    }
  });
});

// ============================================================================
// Receive-Pack Ref 测试
// ============================================================================

describe("receive-pack ref advertisement", () => {
  let tempDir: string;
  let repoDir: string;
  let serverUrl: string;
  let commitHash: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-http-receive-pack");
    const created = createServerRepo(tempDir, "test.git", true);
    repoDir = created.repoDir;
    commitHash = created.commitHash;
    server = startGitHttpBackendServer(tempDir, "/test.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("解析 receive-pack ref advertisement", async () => {
    const transport = createSmartHttpClient(serverUrl);
    const adv = await transport.getReceivePackRefs();

    expect(adv.refs.length).toBeGreaterThanOrEqual(1);

    const mainRef = adv.refs.find((r) => r.name === "refs/heads/main");
    expect(mainRef).toBeDefined();
    expect(mainRef!.hash).toBe(sha1(commitHash));

    expect(adv.capabilities["report-status"]).toBe(true);
    expect(adv.capabilities["side-band-64k"]).toBe(true);
    expect(adv.capabilities["ofs-delta"]).toBe(true);
    expect(adv.capabilities["delete-refs"]).toBe(true);
  });

  test("解析带多个分支的 receive-pack ref advertisement", async () => {
    const branchDir = join(tempDir, "branch-work");
    gitInit(branchDir);
    createFile(branchDir, "feature.md", "# Feature\n");
    git(["add", "feature.md"], branchDir);
    git(["commit", "-m", "Feature commit"], branchDir);
    git(["push", repoDir, "HEAD:refs/heads/feature"], branchDir);

    const transport = createSmartHttpClient(serverUrl);
    const adv = await transport.getReceivePackRefs();

    const featureRef = adv.refs.find((r) => r.name === "refs/heads/feature");
    expect(featureRef).toBeDefined();
  });
});

// ============================================================================
// Upload-Pack 直接调用
// ============================================================================

describe("upload-pack 直接调用", () => {
  let tempDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-http-upload-pack-direct");
    createServerRepo(tempDir, "test.git");
    server = startGitHttpBackendServer(tempDir, "/test.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("postUploadPack 返回正确 packfile", async () => {
    const transport = createSmartHttpClient(serverUrl);
    const adv = await transport.getRefAdvertisement();
    const mainRef = adv.refs.find((r) => r.name === "refs/heads/main");
    expect(mainRef).toBeDefined();

    const { buildUploadPackRequest } = await import("../../src/transport/negotiate.ts");
    const caps = ["multi_ack", "side-band-64k", "ofs-delta"];
    const body = buildUploadPackRequest([mainRef!.hash], [], caps);

    const result = await transport.postUploadPack(body);
    expect(result.packfile.length).toBeGreaterThan(0);
    expect(result.packfile.subarray(0, 4).toString("utf-8")).toBe("PACK");
  });
});

// ============================================================================
// 完整 Fetch 流程
// ============================================================================

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

// ============================================================================
// Fetch 协商流程
// ============================================================================

describe("fetch 协商流程", () => {
  let tempDir: string;
  let repoDir: string;
  let projectRoot: string;
  let workDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-http-fetch-negotiate");
    const remote = createServerRepo(tempDir, "remote.git");
    repoDir = remote.repoDir;
    projectRoot = remote.projectRoot;
    workDir = remote.workDir;

    server = startGitHttpBackendServer(projectRoot, "/remote.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("增量 fetch：远端推进后发送 haves 并仅拉取新增对象", async () => {
    const localDir = join(tempDir, "local-http-incremental");
    const repo = initRepository(localDir);

    const initialHead = git(["rev-parse", "HEAD"], workDir);
    const result1 = await repo.fetch(serverUrl);
    expect(result1.objectCount).toBeGreaterThan(0);

    const firstUploadPackRequests = getUploadPackRequests(server.requests);
    expect(firstUploadPackRequests).toHaveLength(1);
    const firstCommands = decodeUploadPackCommands(firstUploadPackRequests[0]!.body);
    expect(firstCommands.some((line) => line.startsWith("have "))).toBe(false);

    server.clearRequests();

    createFile(workDir, "src/http-feature-a.ts", 'export const a = "a";\n');
    git(["add", "src/http-feature-a.ts"], workDir);
    git(["commit", "-m", "Add HTTP feature a"], workDir);

    createFile(workDir, "src/http-feature-b.ts", 'export const b = "b";\n');
    git(["add", "src/http-feature-b.ts"], workDir);
    git(["commit", "-m", "Add HTTP feature b"], workDir);

    const newHead = git(["rev-parse", "HEAD"], workDir);
    git(["push", repoDir, "main"], workDir);
    const expectedNewObjects = git(
      ["rev-list", "--objects", "--no-object-names", `${initialHead}..${newHead}`],
      workDir,
    )
      .split("\n")
      .filter((line) => line.length > 0).length;

    const result2 = await repo.fetch(serverUrl);

    expect(result2.objectCount).toBeGreaterThan(0);
    expect(result2.objectCount).toBe(expectedNewObjects);
    expect(result2.fetchedRefs.get("refs/remotes/origin/main")).toBe(sha1(newHead));

    const secondUploadPackRequests = getUploadPackRequests(server.requests);
    expect(secondUploadPackRequests).toHaveLength(1);
    const secondCommands = decodeUploadPackCommands(secondUploadPackRequests[0]!.body);
    expect(secondCommands.some((line) => line === `have ${initialHead}`)).toBe(true);
    expect(secondCommands.some((line) => line.startsWith(`want ${newHead}`))).toBe(true);
  });

  test("增量 fetch：超过 32 个 haves 时使用多轮协商", async () => {
    const localDir = join(tempDir, "local-http-batched-haves");
    const repo = initRepository(localDir);

    const totalInitialCommits = 36;
    for (let i = 0; i < totalInitialCommits; i++) {
      createFile(workDir, `history/http-commit-${i}.txt`, `commit-${i}\n`);
      git(["add", `history/http-commit-${i}.txt`], workDir);
      git(["commit", "-m", `HTTP history commit ${i}`], workDir);
    }
    git(["push", repoDir, "main"], workDir);

    const result1 = await repo.fetch(serverUrl);
    expect(result1.objectCount).toBeGreaterThan(totalInitialCommits);

    server.clearRequests();

    createFile(workDir, "history/http-new-a.txt", "new-a\n");
    git(["add", "history/http-new-a.txt"], workDir);
    git(["commit", "-m", "HTTP new history a"], workDir);

    createFile(workDir, "history/http-new-b.txt", "new-b\n");
    git(["add", "history/http-new-b.txt"], workDir);
    git(["commit", "-m", "HTTP new history b"], workDir);

    const newHead = git(["rev-parse", "HEAD"], workDir);
    git(["push", repoDir, "main"], workDir);

    const result2 = await repo.fetch(serverUrl);

    expect(result2.objectCount).toBeGreaterThan(0);
    expect(result2.objectCount).toBeLessThan(result1.objectCount);
    expect(result2.fetchedRefs.get("refs/remotes/origin/main")).toBe(sha1(newHead));

    const uploadPackRequests = getUploadPackRequests(server.requests);
    expect(uploadPackRequests).toHaveLength(2);

    const secondBody = uploadPackRequests[0]!.body;
    const thirdBody = uploadPackRequests[1]!.body;
    const secondCommands = decodeUploadPackCommands(secondBody);
    const thirdCommands = decodeUploadPackCommands(thirdBody);
    const sentHaves = [...secondCommands, ...thirdCommands].filter((line) =>
      line.startsWith("have "),
    );

    expect(secondCommands.filter((line) => line.startsWith("have "))).toHaveLength(32);
    expect(countFlushPackets(secondBody)).toBe(2);
    expect(secondCommands.at(-1)).not.toBe("done");

    expect(thirdCommands.filter((line) => line.startsWith("have ")).length).toBeGreaterThan(0);
    expect(sentHaves.length).toBeGreaterThan(32);
    expect(new Set(sentHaves).size).toBe(sentHaves.length);
    expect(countFlushPackets(thirdBody)).toBe(1);
    expect(thirdCommands.at(-1)).toBe("done");

    const mainRef = repo.refs.readRaw("refs/remotes/origin/main");
    expect(mainRef).toBe(newHead);
    expect(repo.objects.read(sha1(newHead)).type).toBe("commit");
  });
});
