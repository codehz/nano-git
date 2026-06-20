/**
 * Smart HTTP Push — CGI 端到端测试
 *
 * 直接通过 stdio 调用 git http-backend CGI 测试完整 push 流程。
 *
 * 测试方式：
 * - 创建服务端裸仓库（启用 http.receivepack）
 * - 使用 nano-git 的 buildReceivePackRequest 构造请求
 * - 通过 CGI 环境变量调用 git-http-backend
 * - 解析 report-status 验证结果
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { git, gitInit, createTempDir, cleanupDir, createFile, FIXED_AUTHOR } from "./helpers.ts";

import { sha1 } from "../../src/core/types.ts";
import { buildReceivePackRequest } from "../../src/transport/receive-pack-request.ts";
import { parseReceivePackResult } from "../../src/transport/receive-pack-result.ts";
import { extractPackfile } from "../../src/transport/side-band.ts";
import { parsePktLines, encodePktLine, encodeFlushPkt } from "../../src/transport/pkt-line.ts";

// ============================================================================
// 常量
// ============================================================================

/** git http-backend 的路径 */
const HTTP_BACKEND = "/usr/lib/git-core/git-http-backend";

/** CGI 环境变量 */
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
  GIT_HTTP_MAX_REQUEST_BUFFER: "10M",
};

// ============================================================================
// CGI 辅助函数
// ============================================================================

interface CgiResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function callGitHttpBackend(
  repoDir: string,
  projectRoot: string,
  method: string,
  pathInfo: string,
  queryString?: string,
  body?: Buffer,
): CgiResult {
  const contentType =
    method === "POST"
      ? pathInfo.includes("git-receive-pack")
        ? "application/x-git-receive-pack-request"
        : "application/x-git-upload-pack-request"
      : "";

  const env: Record<string, string> = {
    ...GIT_ENV,
    REQUEST_METHOD: method,
    GIT_PROJECT_ROOT: projectRoot,
    PATH_INFO: pathInfo,
    CONTENT_TYPE: contentType,
    QUERY_STRING: queryString ?? "",
  };

  const result = spawnSync(HTTP_BACKEND, [], {
    env: { ...process.env, ...env },
    input: body,
  });

  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr?.toString() ?? "";

  const headerEndIndex = stdout.indexOf("\r\n\r\n");
  if (headerEndIndex === -1) {
    throw new Error(
      `CGI output has no header/body separator\nstdout: ${stdout.toString("utf-8").slice(0, 200)}\nstderr: ${stderr}`,
    );
  }

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
      headers[trimmedLine.slice(0, colonIndex)] = trimmedLine.slice(colonIndex + 2);
    }
  }

  return { status, headers, body: bodyBuffer };
}

/** 获取仓库目录名称 */
function repoName(repoDir: string): string {
  return repoDir.split("/").pop()!;
}

/** 启用仓库的 receive-pack 服务 */
function enableReceivePack(repoDir: string): void {
  const configPath = join(repoDir, "config");
  const config = readFileSync(configPath, "utf-8");
  if (!config.includes("http.receivepack")) {
    writeFileSync(configPath, config + "\n[http]\n\treceivepack = true\n", "utf-8");
  }
}

// ============================================================================
// 测试
// ============================================================================

describe("CGI: push (receive-pack) 端到端", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let projectRoot: string;
  let workDir: string;

  /** 服务端的原始提交哈希（push 前的基准） */
  let serverCommitHash: string;
  /** 本地新提交的哈希 */
  let localCommitHash: string;
  /** 本地第二个新提交的哈希 */
  let localCommitHash2: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-push");

    // 1. 创建服务端裸仓库（启用 receive-pack）
    serverRepoDir = join(tempDir, "server.git");
    projectRoot = tempDir;
    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);
    enableReceivePack(serverRepoDir);

    // 2. 创建工作目录，创建初始提交并推送到服务端
    workDir = join(tempDir, "work");
    gitInit(workDir);
    createFile(workDir, "README.md", "# Hello\n");
    git(["add", "README.md"], workDir);
    git(["commit", "-m", "Initial commit"], workDir);
    serverCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    // 3. 再创建一个提交（这个 commit 只存在于本地，后续用于 push）
    createFile(workDir, "FEATURE.md", "# Feature\n");
    git(["add", "FEATURE.md"], workDir);
    git(["commit", "-m", "Feature commit"], workDir);
    localCommitHash = git(["rev-parse", "HEAD"], workDir);

    // 4. 创建第二个新提交
    createFile(workDir, "OTHER.md", "# Other\n");
    git(["add", "OTHER.md"], workDir);
    git(["commit", "-m", "Other commit"], workDir);
    localCommitHash2 = git(["rev-parse", "HEAD"], workDir);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  test("完整 push 流程：推送新提交到远程", () => {
    // 1. 构造 receive-pack 请求 body
    const commands = [
      {
        oldHash: sha1(serverCommitHash),
        newHash: sha1(localCommitHash2),
        refName: "refs/heads/main",
      },
    ];

    // 2. 从工作目录获取需要发送的对象（packfile）
    // 使用 git 生成 packfile（增量：从 serverCommitHash 到 localCommitHash2）
    const packResult = spawnSync("git", ["-C", workDir, "pack-objects", "--stdout", "--revs"], {
      env: { ...process.env, ...GIT_ENV },
      input: `${localCommitHash2}\n^${serverCommitHash}\n`,
    });
    expect(packResult.status).toBe(0);
    const packfile = packResult.stdout ?? Buffer.alloc(0);
    expect(packfile.length).toBeGreaterThan(0);

    const caps = ["report-status", "side-band-64k", "ofs-delta"];
    const body = buildReceivePackRequest(commands, packfile, caps);

    // 3. 调用 CGI
    const cgiResult = callGitHttpBackend(
      serverRepoDir,
      projectRoot,
      "POST",
      `/${repoName(serverRepoDir)}/git-receive-pack`,
      undefined,
      body,
    );

    expect(cgiResult.status).toBe(200);
    expect(cgiResult.headers["Content-Type"]).toBe("application/x-git-receive-pack-result");

    // 4. 解析 report-status
    let refUpdates;
    try {
      const packfileData = extractPackfile(cgiResult.body);
      refUpdates = parseReceivePackResult(packfileData);
    } catch {
      refUpdates = parseReceivePackResult(cgiResult.body);
    }

    expect(refUpdates.length).toBeGreaterThanOrEqual(1);
    const mainUpdate = refUpdates.find((u) => u.refName === "refs/heads/main");
    expect(mainUpdate).toBeDefined();
    expect(mainUpdate!.success).toBe(true);

    // 5. 验证服务端 ref 已更新（使用 --git-dir 避免 safe.bareRepository 限制）
    const serverRef = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/main"], tempDir);
    expect(serverRef).toBe(localCommitHash2);

    // 6. 验证对象可通过 git cat-file 读取
    const featureContent = git(
      ["--git-dir", serverRepoDir, "cat-file", "-p", `${localCommitHash2}:FEATURE.md`],
      tempDir,
    );
    expect(featureContent).toBe("# Feature");
  });

  test("push 后服务端可 fetch 到新对象", () => {
    // 1. 先推送一个提交到服务端
    const commands = [
      {
        oldHash: sha1(serverCommitHash),
        newHash: sha1(localCommitHash),
        refName: "refs/heads/main",
      },
    ];

    const packResult = spawnSync("git", ["-C", workDir, "pack-objects", "--stdout", "--revs"], {
      env: { ...process.env, ...GIT_ENV },
      input: `${localCommitHash}\n^${serverCommitHash}\n`,
    });
    expect(packResult.status).toBe(0);
    const packfile = packResult.stdout ?? Buffer.alloc(0);
    expect(packfile.length).toBeGreaterThan(0);

    const caps = ["report-status", "side-band-64k", "ofs-delta"];
    const body = buildReceivePackRequest(commands, packfile, caps);

    const pushResult = callGitHttpBackend(
      serverRepoDir,
      projectRoot,
      "POST",
      `/${repoName(serverRepoDir)}/git-receive-pack`,
      undefined,
      body,
    );
    expect(pushResult.status).toBe(200);

    // 2. 通过 upload-pack 验证新对象可从服务端 fetch
    const fetchQuery = callGitHttpBackend(
      serverRepoDir,
      projectRoot,
      "GET",
      `/${repoName(serverRepoDir)}/info/refs`,
      "service=git-upload-pack",
    );
    expect(fetchQuery.status).toBe(200);

    // 3. 验证服务端 refs 包含我们的提交
    const serverRef = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/main"], tempDir);
    expect(serverRef).toBe(localCommitHash);
  });

  test("删除远程分支 push", () => {
    // 1. 先推送一个新分支
    createFile(workDir, "BRANCH.md", "# Branch\n");
    git(["add", "BRANCH.md"], workDir);
    git(["commit", "-m", "Branch commit"], workDir);
    const branchHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, `HEAD:refs/heads/feature`], workDir);

    // 验证分支存在
    const branchRef = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/feature"], tempDir);
    expect(branchRef).toBe(branchHash);

    // 2. 构造删除分支的 push 命令（newHash 为 000...0）
    const deleteCommands = [
      {
        oldHash: sha1(branchHash),
        newHash: sha1("0000000000000000000000000000000000000000"),
        refName: "refs/heads/feature",
      },
    ];

    const ZERO_HASH = "0000000000000000000000000000000000000000" as const;
    const deletePackResult = spawnSync(
      "git",
      ["-C", workDir, "pack-objects", "--stdout", "--revs"],
      {
        env: { ...process.env, ...GIT_ENV },
        input: `${ZERO_HASH}\n^${branchHash}\n`,
      },
    );
    const deletePackfile = deletePackResult.stdout ?? Buffer.alloc(0);

    const deleteCaps = ["report-status", "side-band-64k", "ofs-delta", "delete-refs"];
    const deleteBody = buildReceivePackRequest(deleteCommands, deletePackfile, deleteCaps);

    const deleteResult = callGitHttpBackend(
      serverRepoDir,
      projectRoot,
      "POST",
      `/${repoName(serverRepoDir)}/git-receive-pack`,
      undefined,
      deleteBody,
    );

    expect(deleteResult.status).toBe(200);

    // 3. 解析 report-status
    let refUpdates;
    try {
      const packfileData = extractPackfile(deleteResult.body);
      refUpdates = parseReceivePackResult(packfileData);
    } catch {
      refUpdates = parseReceivePackResult(deleteResult.body);
    }

    const featureUpdate = refUpdates.find((u) => u.refName === "refs/heads/feature");
    expect(featureUpdate).toBeDefined();
    expect(featureUpdate!.success).toBe(true);

    // 4. 验证远程分支已被删除
    const branchList = git(["--git-dir", serverRepoDir, "branch", "-a"], tempDir);
    expect(branchList).not.toContain("feature");
  });
});
