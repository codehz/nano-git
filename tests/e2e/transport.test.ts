/**
 * CgiTransport 集成测试
 *
 * 通过 CgiTransport 将 fetch/push 高层 API 接入 git http-backend CGI，
 * 验证 ref advertisement、upload-pack（fetch）、receive-pack（push）的完整流程。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { git, gitInit, createTempDir, cleanupDir, createFile, FIXED_AUTHOR } from "./helpers.ts";

import { sha1 } from "../../src/core/types.ts";
import { createCgiTransport } from "../../src/transport/cgi-transport.ts";
import { initRepository } from "../../src/repository/index.ts";

// ============================================================================
// 常量
// ============================================================================

const HTTP_BACKEND = "/usr/lib/git-core/git-http-backend";

const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: FIXED_AUTHOR.name,
  GIT_AUTHOR_EMAIL: FIXED_AUTHOR.email,
  GIT_AUTHOR_DATE: `${FIXED_AUTHOR.timestamp} ${FIXED_AUTHOR.timezone}`,
  GIT_COMMITTER_NAME: FIXED_AUTHOR.name,
  GIT_COMMITTER_EMAIL: FIXED_AUTHOR.email,
  GIT_COMMITTER_DATE: `${FIXED_AUTHOR.timestamp} ${FIXED_AUTHOR.timezone}`,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_HTTP_EXPORT_ALL: "1",
};

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

// ============================================================================
// Ref Advertisement 测试
// ============================================================================

describe("CgiTransport: ref advertisement", () => {
  let tempDir: string;
  let repoDir: string;
  let projectRoot: string;
  let commitHash: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-transport");
    const server = createServerRepo(tempDir, "test.git");
    repoDir = server.repoDir;
    projectRoot = server.projectRoot;
    commitHash = server.commitHash;
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  test("解析 ref advertisement 并验证 refs", async () => {
    const transport = createCgiTransport(repoDir, projectRoot, HTTP_BACKEND);
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
    // 创建额外分支：用系统 git 从另一个工作目录 push
    const branchDir = join(tempDir, "branch-work");
    gitInit(branchDir);
    createFile(branchDir, "feature.md", "# Feature\n");
    git(["add", "feature.md"], branchDir);
    git(["commit", "-m", "Feature commit"], branchDir);
    git(["push", repoDir, "HEAD:refs/heads/feature"], branchDir);

    const transport = createCgiTransport(repoDir, projectRoot, HTTP_BACKEND);
    const adv = await transport.getRefAdvertisement();

    const featureRef = adv.refs.find((r) => r.name === "refs/heads/feature");
    expect(featureRef).toBeDefined();
  });

  test("空仓库应返回 capabilities 但无 refs", async () => {
    const emptyDir = join(tempDir, "empty.git");
    mkdirSync(emptyDir);
    git(["init", "--bare"], emptyDir);

    const transport = createCgiTransport(emptyDir, tempDir, HTTP_BACKEND);
    const adv = await transport.getRefAdvertisement();

    expect(adv.refs).toHaveLength(0);
    expect(Object.keys(adv.capabilities).length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Upload-Pack (Fetch) 测试
// ============================================================================

describe("CgiTransport: upload-pack (fetch)", () => {
  let tempDir: string;
  let repoDir: string;
  let projectRoot: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-transport-fetch");
    const server = createServerRepo(tempDir, "test.git");
    repoDir = server.repoDir;
    projectRoot = server.projectRoot;
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  test("CgiTransport 配合 repo.fetch() 完成拉取", async () => {
    // CgiTransport 注入给 initRepository 的 repo
    const localDir = join(tempDir, "local");
    const repo = initRepository(localDir);
    const transport = createCgiTransport(repoDir, projectRoot, HTTP_BACKEND);

    const result = await repo.fetch("dummy", { transport });

    expect(result.objectCount).toBeGreaterThan(0);

    const mainRef = repo.refs.readRaw("refs/remotes/origin/main");
    expect(mainRef).not.toBeNull();
    expect(mainRef!.length).toBe(40);
  });

  test("CgiTransport fetch 到已存在对象的仓库（增量场景）", async () => {
    const localDir = join(tempDir, "local2");
    const repo = initRepository(localDir);
    const transport = createCgiTransport(repoDir, projectRoot, HTTP_BACKEND);

    const result1 = await repo.fetch("dummy", { transport });
    expect(result1.objectCount).toBeGreaterThan(0);

    const result2 = await repo.fetch("dummy", { transport });
    expect(result2.objectCount).toBe(0);
  });

  test("CgiTransport: postUploadPack 返回正确 packfile", async () => {
    const transport = createCgiTransport(repoDir, projectRoot, HTTP_BACKEND);
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
// Receive-Pack (Push) 测试
// ============================================================================

describe("CgiTransport: receive-pack (push)", () => {
  let tempDir: string;
  let repoDir: string;
  let projectRoot: string;
  let commitHash: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-transport-push");
    const server = createServerRepo(tempDir, "test.git", true);
    repoDir = server.repoDir;
    projectRoot = server.projectRoot;
    commitHash = server.commitHash;
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  test("解析 receive-pack ref advertisement", async () => {
    const transport = createCgiTransport(repoDir, projectRoot, HTTP_BACKEND);
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
    // 创建额外分支：用系统 git 从另一个工作目录 push
    const branchDir = join(tempDir, "branch-work");
    gitInit(branchDir);
    createFile(branchDir, "feature.md", "# Feature\n");
    git(["add", "feature.md"], branchDir);
    git(["commit", "-m", "Feature commit"], branchDir);
    git(["push", repoDir, "HEAD:refs/heads/feature"], branchDir);

    const transport = createCgiTransport(repoDir, projectRoot, HTTP_BACKEND);
    const adv = await transport.getReceivePackRefs();

    const featureRef = adv.refs.find((r) => r.name === "refs/heads/feature");
    expect(featureRef).toBeDefined();
  });
});

// ============================================================================
// 完整 Fetch 流程（通过 HTTP 服务器）
// ============================================================================

describe("完整 fetch 流程（HTTP 服务器）", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let projectRoot: string;
  let serverUrl: string;
  let server: { stop(): void };

  beforeEach(() => {
    tempDir = createTempDir("e2e-full-fetch");

    // 1. 创建服务端裸仓库
    serverRepoDir = join(tempDir, "server.git");
    projectRoot = tempDir;
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

    // 3. 启动 Bun HTTP 服务器代理 git http-backend
    const port = 17890 + Math.floor(Math.random() * 1000);

    server = Bun.serve({
      port,
      async fetch(req) {
        const url = new URL(req.url);
        const method = req.method;

        if (!url.pathname.includes("/info/refs") && !url.pathname.includes("/git-upload-pack")) {
          return new Response("Not Found", { status: 404 });
        }

        const pathInfo = url.pathname;

        const env: Record<string, string> = {
          ...GIT_ENV,
          REQUEST_METHOD: method,
          GIT_PROJECT_ROOT: projectRoot,
          PATH_INFO: pathInfo,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: method === "POST" ? "application/x-git-upload-pack-request" : "",
        };

        const body = method === "POST" ? await req.arrayBuffer() : undefined;

        const result = spawnSync(HTTP_BACKEND, [], {
          env: { ...process.env, ...env },
          input: body ? Buffer.from(body) : undefined,
        });

        const stdout = result.stdout ?? Buffer.alloc(0);
        const headerEndIndex = stdout.indexOf("\r\n\r\n");

        if (headerEndIndex === -1) {
          return new Response("CGI error", { status: 500 });
        }

        const headerSection = stdout.subarray(0, headerEndIndex).toString("utf-8");
        const bodyBuffer = stdout.subarray(headerEndIndex + 4);
        let statusCode = 200;

        for (const line of headerSection.split("\r\n")) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith("Status: ")) {
            statusCode = parseInt(trimmedLine.slice(8), 10);
            break;
          }
        }

        let contentType = "application/octet-stream";
        for (const line of headerSection.split("\r\n")) {
          const trimmedLine = line.trim();
          const colonIndex = trimmedLine.indexOf(": ");
          if (
            colonIndex !== -1 &&
            trimmedLine.slice(0, colonIndex).toLowerCase() === "content-type"
          ) {
            contentType = trimmedLine.slice(colonIndex + 2);
            break;
          }
        }

        return new Response(bodyBuffer, {
          status: statusCode,
          headers: { "Content-Type": contentType },
        });
      },
    });

    serverUrl = `http://localhost:${port}/server.git`;
  });

  afterEach(() => {
    server?.stop();
    cleanupDir(tempDir);
  });

  test("完整初始 clone 流程（使用 repo.fetch()）", async () => {
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

  test("fetch 到已存在对象的仓库（增量 fetch 场景）", async () => {
    const localDir = join(tempDir, "local2");
    const repo = initRepository(localDir);

    const result1 = await repo.fetch(serverUrl);
    expect(result1.objectCount).toBeGreaterThan(0);

    const result2 = await repo.fetch(serverUrl);
    expect(result2.objectCount).toBe(0);
    expect(result2.fetchedRefs.size).toBe(0);
  });
});
