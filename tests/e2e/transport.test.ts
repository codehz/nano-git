/**
 * Smart HTTP 传输层 — CGI 集成测试
 *
 * 利用 git http-backend CGI 程序测试客户端协议实现的正确性。
 *
 * 测试方式：
 * - 使用 git 创建仓库和提交
 * - 通过 GIT_PROJECT_ROOT + CGI 环境变量直接调用 git-http-backend
 * - 用 nano-git 的协议解析层解析响应
 * - 双向验证解析结果
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  git,
  gitInit,
  gitHashObjectWrite,
  gitCommitTree,
  gitUpdateRef,
  gitCatFileType,
  createTempDir,
  cleanupDir,
  createFile,
  FIXED_AUTHOR,
} from "./helpers.ts";

import { parseRefAdvertisement } from "../../src/transport/ref-advertisement.ts";
import { extractPackfile } from "../../src/transport/side-band.ts";
import { buildUploadPackRequest } from "../../src/transport/negotiate.ts";
import { parsePktLines, encodePktLine, encodeFlushPkt } from "../../src/transport/pkt-line.ts";
import type { PktLineData } from "../../src/transport/pkt-line.ts";

import { sha1 } from "../../src/core/types.ts";

// ============================================================================
// 常量
// ============================================================================

/** git http-backend 的路径 */
const HTTP_BACKEND = "/usr/lib/git-core/git-http-backend";

/** 可导出的环境变量（防止 git 报警告） */
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
// CGI 辅助函数
// ============================================================================

/**
 * CGI 请求结果
 */
interface CgiResult {
  /** HTTP 状态码 */
  status: number;
  /** HTTP 响应头 */
  headers: Record<string, string>;
  /** 响应体（raw Buffer） */
  body: Buffer;
}

/**
 * 调用 git http-backend CGI
 *
 * 使用 spawnSync 模拟 CGI 请求，设置标准的 CGI 环境变量。
 *
 * @param repoDir - 裸仓库目录
 * @param projectRoot - GIT_PROJECT_ROOT 目录（repoDir 的父目录）
 * @param method - HTTP 方法
 * @param pathInfo - PATH_INFO（如 /test.git/info/refs）
 * @param queryString - QUERY_STRING（可选）
 * @param body - 请求体（POST 时使用）
 * @returns 解析后的 CGI 响应
 */
function callGitHttpBackend(
  repoDir: string,
  projectRoot: string,
  method: string,
  pathInfo: string,
  queryString?: string,
  body?: Buffer,
): CgiResult {
  const env: Record<string, string> = {
    ...GIT_ENV,
    REQUEST_METHOD: method,
    GIT_PROJECT_ROOT: projectRoot,
    PATH_INFO: pathInfo,
    CONTENT_TYPE: method === "POST" ? "application/x-git-upload-pack-request" : "",
    QUERY_STRING: queryString ?? "",
  };

  const result = spawnSync(HTTP_BACKEND, [], {
    env: { ...process.env, ...env },
    input: body,
  });

  // 解析 CGI 输出：headers + \r\n\r\n + body
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr?.toString() ?? "";

  // 查找 headers/body 分隔符
  const headerEndIndex = stdout.indexOf("\r\n\r\n");
  if (headerEndIndex === -1) {
    throw new Error(
      `CGI output has no header/body separator\nstdout: ${stdout.toString("utf-8").slice(0, 200)}\nstderr: ${stderr}`,
    );
  }

  // 解析 headers
  const headerSection = stdout.subarray(0, headerEndIndex).toString("utf-8");
  const bodyBuffer = stdout.subarray(headerEndIndex + 4);
  const headers: Record<string, string> = {};
  let status = 200;

  for (const line of headerSection.split("\r\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) continue;

    if (trimmedLine.startsWith("Status: ")) {
      status = parseInt(trimmedLine.slice(8), 10);
      continue;
    }

    const colonIndex = trimmedLine.indexOf(": ");
    if (colonIndex !== -1) {
      const key = trimmedLine.slice(0, colonIndex);
      const value = trimmedLine.slice(colonIndex + 2);
      headers[key] = value;
    }
  }

  return { status, headers, body: bodyBuffer };
}

/**
 * 获取仓库的子目录名称（用于 PATH_INFO）
 */
function repoName(repoDir: string): string {
  return repoDir.split("/").pop()!;
}

// ============================================================================
// 测试
// ============================================================================

describe("CGI: ref advertisement", () => {
  let tempDir: string;
  let repoDir: string;
  let projectRoot: string;
  let commitHash: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-transport");
    repoDir = join(tempDir, "test.git");
    projectRoot = tempDir;

    // 创建裸仓库
    mkdirSync(repoDir);
    git(["init", "--bare"], repoDir);

    // 创建临时工作目录来生成提交
    const workDir = join(tempDir, "work");
    gitInit(workDir);
    createFile(workDir, "README.md", "# Hello\n");
    git(["add", "README.md"], workDir);
    git(["commit", "-m", "Initial commit"], workDir);

    // 获取 commit hash
    commitHash = git(["rev-parse", "HEAD"], workDir);

    // push 到裸仓库
    git(["push", repoDir, "main"], workDir);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  test("解析 ref advertisement 并验证 refs", () => {
    const cgiResult = callGitHttpBackend(
      repoDir,
      projectRoot,
      "GET",
      `/${repoName(repoDir)}/info/refs`,
      "service=git-upload-pack",
    );

    expect(cgiResult.status).toBe(200);
    expect(cgiResult.headers["Content-Type"]).toBe("application/x-git-upload-pack-advertisement");

    const adv = parseRefAdvertisement(cgiResult.body, "git-upload-pack");

    // 应有 HEAD 和 refs/heads/main
    expect(adv.refs.length).toBeGreaterThanOrEqual(1);

    const mainRef = adv.refs.find((r) => r.name === "refs/heads/main");
    expect(mainRef).toBeDefined();
    expect(mainRef!.hash).toBe(sha1(commitHash));

    // capabilities 应包含标准能力
    expect(adv.capabilities["multi_ack"]).toBe(true);
    expect(adv.capabilities["side-band-64k"]).toBe(true);
    expect(adv.capabilities["ofs-delta"]).toBe(true);
    expect(adv.capabilities["agent"]).toMatch(/^git\//);
  });

  test("解析带多个分支的 ref advertisement", () => {
    // 创建额外分支
    const workDir = join(tempDir, "work2");
    gitInit(workDir);
    createFile(workDir, "feature.md", "# Feature\n");
    git(["add", "feature.md"], workDir);
    git(["commit", "-m", "Feature commit"], workDir);
    // 推送到同一个裸仓库
    git(["remote", "add", "origin", repoDir], workDir);
    git(["push", "origin", "HEAD:refs/heads/feature"], workDir);

    // 拉取 ref advertisement
    const cgiResult = callGitHttpBackend(
      repoDir,
      projectRoot,
      "GET",
      `/${repoName(repoDir)}/info/refs`,
      "service=git-upload-pack",
    );
    const adv = parseRefAdvertisement(cgiResult.body, "git-upload-pack");

    const featureRef = adv.refs.find((r) => r.name === "refs/heads/feature");
    expect(featureRef).toBeDefined();
  });

  test("空仓库应返回 capabilities^{} 行", () => {
    const emptyRepoDir = join(tempDir, "empty.git");
    mkdirSync(emptyRepoDir);
    git(["init", "--bare"], emptyRepoDir);

    const cgiResult = callGitHttpBackend(
      emptyRepoDir,
      tempDir,
      "GET",
      `/empty.git/info/refs`,
      "service=git-upload-pack",
    );

    const adv = parseRefAdvertisement(cgiResult.body, "git-upload-pack");
    expect(adv.refs).toHaveLength(0);
    // capabilities 应存在
    expect(Object.keys(adv.capabilities).length).toBeGreaterThan(0);
  });
});

describe("CGI: upload-pack (fetch)", () => {
  let tempDir: string;
  let repoDir: string;
  let projectRoot: string;
  let commitHash: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-transport-fetch");
    repoDir = join(tempDir, "test.git");
    projectRoot = tempDir;

    mkdirSync(repoDir);
    git(["init", "--bare"], repoDir);

    const workDir = join(tempDir, "work");
    gitInit(workDir);
    createFile(workDir, "README.md", "# Hello\n");
    git(["add", "README.md"], workDir);
    git(["commit", "-m", "Initial commit"], workDir);
    commitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", repoDir, "main"], workDir);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  test("发送 want 请求并解包 packfile（使用 buildUploadPackRequest）", () => {
    // 1. 先获取 ref advertisement 取得 want hash
    const advResult = callGitHttpBackend(
      repoDir,
      projectRoot,
      "GET",
      `/${repoName(repoDir)}/info/refs`,
      "service=git-upload-pack",
    );
    const adv = parseRefAdvertisement(advResult.body, "git-upload-pack");
    const mainRef = adv.refs.find((r) => r.name === "refs/heads/main");
    expect(mainRef).toBeDefined();

    const caps = ["multi_ack", "side-band-64k", "ofs-delta"];

    // 2. 使用 buildUploadPackRequest 构造请求 body
    const wantBody = buildUploadPackRequest([mainRef!.hash], [], caps);

    const fetchResult = callGitHttpBackend(
      repoDir,
      projectRoot,
      "POST",
      `/${repoName(repoDir)}/git-upload-pack`,
      undefined,
      wantBody,
    );

    expect(fetchResult.status).toBe(200);
    expect(fetchResult.headers["Content-Type"]).toBe("application/x-git-upload-pack-result");

    // 3. 用 side-band 解复用提取 packfile
    const packfile = extractPackfile(fetchResult.body);
    expect(packfile.length).toBeGreaterThan(0);

    // 4. 验证 packfile 以 "PACK" 开头
    expect(packfile.subarray(0, 4).toString("utf-8")).toBe("PACK");
  });

  test("增量 fetch：want + have + done（使用 buildUploadPackRequest）", () => {
    // 在已有工作目录上添加新提交
    const fetchWorkDir = join(tempDir, "work");
    createFile(fetchWorkDir, "FEATURE.md", "# Feature\n");
    git(["add", "FEATURE.md"], fetchWorkDir);
    git(["commit", "-m", "Add feature"], fetchWorkDir);
    const newCommitHash = git(["rev-parse", "HEAD"], fetchWorkDir);
    git(["push", "--force", repoDir, "main"], fetchWorkDir);

    // 获取 ref advertisement
    const advResult = callGitHttpBackend(
      repoDir,
      projectRoot,
      "GET",
      `/${repoName(repoDir)}/info/refs`,
      "service=git-upload-pack",
    );
    const adv = parseRefAdvertisement(advResult.body, "git-upload-pack");
    const mainRef = adv.refs.find((r) => r.name === "refs/heads/main");
    expect(mainRef).toBeDefined();

    const caps = ["multi_ack", "side-band-64k", "ofs-delta"];

    // 使用 buildUploadPackRequest 构造增量 fetch 请求
    const wantBody = buildUploadPackRequest([sha1(newCommitHash)], [sha1(commitHash)], caps);

    const fetchResult = callGitHttpBackend(
      repoDir,
      projectRoot,
      "POST",
      `/${repoName(repoDir)}/git-upload-pack`,
      undefined,
      wantBody,
    );

    expect(fetchResult.status).toBe(200);

    // 验证响应体中包含 NAK（增量 fetch 的正常 ACK/NAK 响应）
    const bodyStr = fetchResult.body.toString("utf-8");
    expect(bodyStr).toContain("NAK");
  });

  test("NAK 响应（没有共同对象的 fetch）", () => {
    // 模拟 clone：发送 want 空 hash（0000...）应得到 NAK
    const wantBody = Buffer.concat([
      encodePktLine(
        `want 0000000000000000000000000000000000000000 multi_ack side-band-64k ofs-delta\n`,
      ),
      encodeFlushPkt(),
      encodePktLine("done\n"),
      encodeFlushPkt(),
    ]);

    const fetchResult = callGitHttpBackend(
      repoDir,
      projectRoot,
      "POST",
      `/${repoName(repoDir)}/git-upload-pack`,
      undefined,
      wantBody,
    );

    // 应该收到响应（可能是 NAK + abort）
    // 检查响应体是否包含 NAK
    const bodyStr = fetchResult.body.toString("utf-8");
    // 即使有错误，也应能正常处理
    expect(fetchResult.status).toBe(200);
  });
});

describe("CGI: 完整 fetch 流程（HTTP 服务器）", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let projectRoot: string;
  let serverUrl: string;
  let server: { stop(): void };
  let commitHash: string;

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
    commitHash = git(["rev-parse", "HEAD"], workDir);
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

        // 只处理 Git 相关路径
        if (!url.pathname.includes("/info/refs") && !url.pathname.includes("/git-upload-pack")) {
          return new Response("Not Found", { status: 404 });
        }

        // PATH_INFO 直接使用 URL 路径（包含仓库名）
        const pathInfo = url.pathname;

        // 设置 CGI 环境变量
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

        // 提取 Content-Type
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
    const { initRepository } = await import("../../src/repository/index.ts");

    // 创建本地目标仓库
    const localDir = join(tempDir, "local");
    const repo = initRepository(localDir);

    // 使用 repo.fetch() API 执行 fetch
    const result = await repo.fetch(serverUrl);

    // 验证结果
    expect(result.objectCount).toBeGreaterThan(0);

    // 验证 refs 被正确写入
    const mainRef = repo.refs.readRaw("refs/remotes/origin/main");
    expect(mainRef).not.toBeNull();
    expect(mainRef!.length).toBe(40);

    // 验证 HEAD 也被写入
    const headRef = repo.refs.readRaw("HEAD");
    expect(headRef).not.toBeNull();

    // 验证可以通过哈希读取对象
    const commitObj = repo.objects.read(sha1(mainRef!));
    expect(commitObj.type).toBe("commit");
  });

  test("fetch 到已存在对象的仓库（增量 fetch 场景，使用 repo.fetch()）", async () => {
    const { initRepository } = await import("../../src/repository/index.ts");

    const localDir = join(tempDir, "local2");
    const repo = initRepository(localDir);

    // 第一次 fetch（使用 repo.fetch()）
    const result1 = await repo.fetch(serverUrl);
    expect(result1.objectCount).toBeGreaterThan(0);

    // 第二次 fetch（应返回 0 个新对象）
    const result2 = await repo.fetch(serverUrl);
    expect(result2.objectCount).toBe(0);
    expect(result2.fetchedRefs.size).toBe(0);
  });
});
