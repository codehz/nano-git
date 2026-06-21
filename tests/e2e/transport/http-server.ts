/**
 * HTTP 测试服务端
 *
 * 基于 Bun.serve 启动真实 HTTP 服务，代理 git http-backend 的 CGI 调用，
 * 用于传输层端到端测试。
 */

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";

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

/** git http-backend 可执行文件 */
const DEFAULT_HTTP_BACKEND = "git";

/** git 命令使用的环境变量 */
const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "E2E Test",
  GIT_AUTHOR_EMAIL: "e2e@nano-git.test",
  GIT_AUTHOR_DATE: "1700000000 +0800",
  GIT_COMMITTER_NAME: "E2E Test",
  GIT_COMMITTER_EMAIL: "e2e@nano-git.test",
  GIT_COMMITTER_DATE: "1700000000 +0800",
  // 允许 bare 仓库操作（兼容 Git >= 2.46 的 safe.bareRepository 安全机制）
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.bareRepository",
  GIT_CONFIG_VALUE_0: "all",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

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
  const entries: Array<[string, string]> = Array.from(headers.entries()).map(([key, value]) => [
    key.toLowerCase(),
    value,
  ]);
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
