/**
 * Git CLI 辅助工具
 *
 * 封装标准 git 命令行调用，用于端到端测试中验证 nano-git 的兼容性。
 * 使用 Bun.spawnSync 同步执行 git 命令。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha1, type SHA1 } from "../../src/core/types.ts";

// ============================================================================
// 固定环境变量（确保测试结果可重复）
// ============================================================================

/** 固定的作者信息，用于 git 命令 */
export const FIXED_AUTHOR = {
  name: "E2E Test",
  email: "e2e@nano-git.test",
  timestamp: 1700000000,
  timezone: "+0800",
};

/** git 命令使用的环境变量 */
const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: FIXED_AUTHOR.name,
  GIT_AUTHOR_EMAIL: FIXED_AUTHOR.email,
  GIT_AUTHOR_DATE: `${FIXED_AUTHOR.timestamp} ${FIXED_AUTHOR.timezone}`,
  GIT_COMMITTER_NAME: FIXED_AUTHOR.name,
  GIT_COMMITTER_EMAIL: FIXED_AUTHOR.email,
  GIT_COMMITTER_DATE: `${FIXED_AUTHOR.timestamp} ${FIXED_AUTHOR.timezone}`,
  // 禁用 GPG 签名
  GIT_CONFIG_NOSYSTEM: "1",
  // 避免 git 提示配置
  GIT_TERMINAL_PROMPT: "0",
};

/** git http-backend 可执行文件 */
const DEFAULT_HTTP_BACKEND = "git";

// ============================================================================
// HTTP 测试服务端
// ============================================================================

/** CGI 响应解析结果 */
interface CgiResponse {
  /** HTTP 状态码 */
  status: number;
  /** 响应头 */
  headers: Record<string, string>;
  /** 响应体 */
  body: Buffer;
}

/** 后端执行失败时返回的诊断头 */
const BACKEND_ERROR_HEADER = "x-nano-git-backend-error";

/** 真实 HTTP 请求记录 */
export interface GitHttpRequestRecord {
  /** 请求方法 */
  method: string;
  /** 请求路径 */
  path: string;
  /** 查询字符串（不含 ?） */
  query: string;
  /** 请求头（全部转为小写） */
  headers: Record<string, string>;
  /** 原始请求体 */
  body: Buffer;
}

/** git-http-backend 测试服务句柄 */
export interface GitHttpBackendServer {
  /** 远程仓库 base URL */
  url: string;
  /** 已捕获的请求列表 */
  requests: GitHttpRequestRecord[];
  /** 清空已捕获请求 */
  clearRequests(): void;
  /** 停止服务 */
  stop(): Promise<void>;
}

/**
 * 解析 git http-backend CGI 输出
 */
function parseCgiResponse(stdout: Buffer): CgiResponse {
  let headerEndIndex = stdout.indexOf("\r\n\r\n");
  let separatorLength = 4;

  if (headerEndIndex === -1) {
    headerEndIndex = stdout.indexOf("\n\n");
    separatorLength = 2;
  }

  if (headerEndIndex === -1) {
    throw new Error(`CGI output has no header/body separator:\n${stdout.toString("utf-8")}`);
  }

  const headerSection = stdout.subarray(0, headerEndIndex).toString("utf-8");
  const body = stdout.subarray(headerEndIndex + separatorLength);
  const headers: Record<string, string> = {};
  let status = 200;

  for (const line of headerSection.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) continue;

    if (trimmedLine.startsWith("Status: ")) {
      status = parseInt(trimmedLine.slice(8), 10);
      continue;
    }

    const colonIndex = trimmedLine.indexOf(": ");
    if (colonIndex === -1) continue;

    headers[trimmedLine.slice(0, colonIndex)] = trimmedLine.slice(colonIndex + 2);
  }

  return { status, headers, body };
}

/**
 * 将 Request Headers 转为普通对象
 */
function toHeaderRecord(headers: Headers): Record<string, string> {
  const entries = Array.from(headers.entries()).map(([key, value]) => [key.toLowerCase(), value]);
  return Object.fromEntries(entries);
}

/**
 * 构造测试后端失败响应，避免请求处理阶段直接抛异常导致连接被中断
 */
function createBackendErrorResponse(message: string): Response {
  return new Response(message, {
    status: 500,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      [BACKEND_ERROR_HEADER]: "1",
    },
  });
}

/**
 * 启动基于 Bun.serve 的真实 git-http-backend 测试服务
 *
 * @param projectRoot - 裸仓库根目录，对应 GIT_PROJECT_ROOT
 * @param repoPath - 远程仓库路径，如 "/server.git"
 * @param httpBackend - git-http-backend 可执行文件路径
 * @returns 测试服务句柄
 *
 * @example
 * ```ts
 * const server = startGitHttpBackendServer("/tmp", "/server.git");
 * const result = await repo.fetch(server.url);
 * await server.stop();
 * ```
 */
export function startGitHttpBackendServer(
  projectRoot: string,
  repoPath: string,
  httpBackend = DEFAULT_HTTP_BACKEND,
): GitHttpBackendServer {
  const normalizedRepoPath = repoPath.startsWith("/") ? repoPath : `/${repoPath}`;
  const infoRefsPath = `${normalizedRepoPath}/info/refs`;
  const uploadPackPath = `${normalizedRepoPath}/git-upload-pack`;
  const receivePackPath = `${normalizedRepoPath}/git-receive-pack`;
  const requests: GitHttpRequestRecord[] = [];

  async function handleBackendRequest(
    req: Request,
    pathInfo: string,
    explicitService?: "git-upload-pack" | "git-receive-pack",
  ): Promise<Response> {
    const url = new URL(req.url);
    const body = req.method === "POST" ? Buffer.from(await req.arrayBuffer()) : Buffer.alloc(0);
    const service = explicitService ?? url.searchParams.get("service");

    requests.push({
      method: req.method,
      path: url.pathname,
      query: url.search.slice(1),
      headers: toHeaderRecord(req.headers),
      body,
    });

    const contentType =
      req.method !== "POST"
        ? ""
        : service === "git-receive-pack"
          ? "application/x-git-receive-pack-request"
          : "application/x-git-upload-pack-request";

    const result = spawnSync(httpBackend, ["http-backend"], {
      env: {
        ...process.env,
        ...GIT_ENV,
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_PROJECT_ROOT: projectRoot,
        REQUEST_METHOD: req.method,
        PATH_INFO: pathInfo,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: contentType,
        CONTENT_LENGTH: req.method === "POST" ? String(body.length) : "0",
      },
      input: body,
    });

    if (result.error) {
      throw new Error(`Failed to execute git http-backend: ${result.error.message}`);
    }

    if (result.status !== 0) {
      const stderr = result.stderr?.toString("utf-8").trim() ?? "";
      throw new Error(`git http-backend failed (exit ${result.status}): ${stderr}`);
    }

    const cgiResponse = parseCgiResponse(result.stdout ?? Buffer.alloc(0));
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(cgiResponse.headers)) {
      responseHeaders.set(key, value);
    }

    return new Response(cgiResponse.body, {
      status: cgiResponse.status,
      headers: responseHeaders,
    });
  }

  const server = Bun.serve({
    port: 0,
    routes: {
      [infoRefsPath]: {
        GET(req: Request) {
          return handleBackendRequest(req, infoRefsPath);
        },
      },
      [uploadPackPath]: {
        POST(req: Request) {
          return handleBackendRequest(req, uploadPackPath, "git-upload-pack");
        },
      },
      [receivePackPath]: {
        POST(req: Request) {
          return handleBackendRequest(req, receivePackPath, "git-receive-pack");
        },
      },
    },
    fetch() {
      return new Response("Not Found", { status: 404 });
    },
    error(error) {
      const message =
        error instanceof Error ? error.message : `Unknown backend error: ${String(error)}`;
      return createBackendErrorResponse(message);
    },
  });

  return {
    url: `http://${server.hostname}:${server.port}${normalizedRepoPath}`,
    requests,
    clearRequests() {
      requests.length = 0;
    },
    stop() {
      return server.stop(true);
    },
  };
}

// ============================================================================
// Git CLI 封装
// ============================================================================

/**
 * 执行 git 命令并返回 stdout
 *
 * @param args - git 命令参数
 * @param cwd - 工作目录
 * @returns stdout 输出（已 trim）
 * @throws 如果命令执行失败
 */
export function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() ?? "";
    const stdout = result.stdout?.toString().trim() ?? "";
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.status}):\n` +
        `stdout: ${stdout}\n` +
        `stderr: ${stderr}`,
    );
  }

  return (result.stdout?.toString() ?? "").trim();
}

/**
 * 执行 git 命令并返回原始 Buffer stdout（用于二进制内容）
 */
export function gitRaw(args: string[], cwd: string): Buffer {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() ?? "";
    throw new Error(`git ${args.join(" ")} failed (exit ${result.status}): ${stderr}`);
  }

  return result.stdout ?? Buffer.alloc(0);
}

// ============================================================================
// 高层 Git 操作
// ============================================================================

/**
 * 初始化 git 仓库
 */
export function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(["init", "-b", "main"], dir);
}

/**
 * 将内容写入 blob 对象（通过 stdin）
 *
 * 等价于: echo -n "<content>" | git hash-object -w --stdin
 */
export function gitHashObjectWrite(dir: string, content: Buffer | string): SHA1 {
  const buf = typeof content === "string" ? Buffer.from(content) : content;
  const result = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: dir,
    env: { ...process.env, ...GIT_ENV },
    input: buf,
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    throw new Error(`git hash-object failed: ${result.stderr}`);
  }

  return sha1(result.stdout.trim());
}

/**
 * 计算内容的 blob 哈希（不写入）
 */
export function gitHashObject(dir: string, content: Buffer | string): SHA1 {
  const buf = typeof content === "string" ? Buffer.from(content) : content;
  const result = spawnSync("git", ["hash-object", "--stdin"], {
    cwd: dir,
    env: { ...process.env, ...GIT_ENV },
    input: buf,
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    throw new Error(`git hash-object failed: ${result.stderr}`);
  }

  return sha1(result.stdout.trim());
}

/**
 * 读取对象内容（-p 模式，pretty print）
 *
 * 等价于: git cat-file -p <hash>
 */
export function gitCatFile(dir: string, hash: string): string {
  return git(["cat-file", "-p", hash], dir);
}

/**
 * 读取对象的原始内容（-s 获取大小，不带 -p 获取原始数据）
 */
export function gitCatFileRaw(dir: string, hash: string): Buffer {
  return gitRaw(["cat-file", "blob", hash], dir);
}

/**
 * 获取对象类型
 */
export function gitCatFileType(dir: string, hash: string): string {
  return git(["cat-file", "-t", hash], dir);
}

/**
 * 获取对象大小
 */
export function gitCatFileSize(dir: string, hash: string): number {
  const size = git(["cat-file", "-s", hash], dir);
  return parseInt(size, 10);
}

/**
 * 将文件写入暂存区并返回 tree hash
 *
 * 使用 git update-index + git write-tree 的方式
 */
export function gitWriteTreeFromFiles(dir: string, files: Record<string, string>): SHA1 {
  // 先写入所有 blob
  const entries: Array<{ hash: SHA1; mode: string; name: string }> = [];

  for (const [name, content] of Object.entries(files)) {
    const hash = gitHashObjectWrite(dir, content);
    const mode = "100644";
    entries.push({ hash, mode, name });
  }

  // 使用 update-index 添加文件
  for (const entry of entries) {
    git(["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.hash},${entry.name}`], dir);
  }

  // write-tree
  return sha1(git(["write-tree"], dir));
}

/**
 * 使用 git commit-tree 创建 commit
 */
export function gitCommitTree(
  dir: string,
  treeHash: string,
  message: string,
  parents: string[] = [],
): SHA1 {
  const args = ["commit-tree", treeHash, "-m", message];
  for (const parent of parents) {
    args.push("-p", parent);
  }
  return sha1(git(args, dir));
}

/**
 * 更新引用
 */
export function gitUpdateRef(dir: string, ref: string, hash: string): void {
  git(["update-ref", ref, hash], dir);
}

/**
 * 解析引用
 */
export function gitRevParse(dir: string, ref: string): SHA1 {
  return sha1(git(["rev-parse", ref], dir));
}

/**
 * 获取 git log 输出
 */
export function gitLog(dir: string, format?: string): string {
  const args = ["log", "--all"];
  if (format) {
    args.push(`--format=${format}`);
  }
  return git(args, dir);
}

/**
 * 验证仓库完整性
 */
export function gitFsck(dir: string): string {
  return git(["fsck", "--no-dangling"], dir);
}

/**
 * 执行 git gc
 */
export function gitGc(dir: string, aggressive = false): void {
  const args = aggressive ? ["gc", "--aggressive"] : ["gc"];
  git(args, dir);
}

// ============================================================================
// 临时目录管理
// ============================================================================

/**
 * 创建临时目录
 */
export function createTempDir(prefix = "nano-git-e2e"): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 清理临时目录
 */
export function cleanupDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 在目录中创建文件
 */
export function createFile(dir: string, name: string, content: string): string {
  const filePath = join(dir, name);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

/**
 * 在目录中创建可执行文件
 */
export function createExecutableFile(dir: string, name: string, content: string): string {
  const filePath = createFile(dir, name, content);
  chmodSync(filePath, 0o755);
  return filePath;
}
