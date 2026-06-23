/**
 * Smart HTTP 后端适配器
 *
 * 类似 git-http-backend 的职责，但以纯 TypeScript 接口形式提供：
 * - 接收框架无关的 HTTP 请求
 * - 解析 Git 协议路由
 * - 委托给 v2 服务层处理
 * - 返回框架无关的 HTTP 响应
 *
 * 当前支持 Git Wire 协议 v2 的 upload-pack（fetch + ls-refs）。
 *
 * 路由：
 * - GET /info/refs?service=git-upload-pack → v2 能力广告
 * - POST /git-upload-pack → ls-refs / fetch 命令
 *
 * @see https://git-scm.com/docs/git-http-backend
 */

import { V2ServeError, createV2UploadPackService, serveV2Advertise } from "../v2/serve.ts";

import type { RepositoryBackend } from "../../repository/backend/types.ts";
import type { GitHttpRequest, GitHttpResponse, SmartHttpHandler } from "./types.ts";

// ============================================================================
// 错误响应
// ============================================================================

/**
 * 创建 HTTP 错误响应
 */
function errorResponse(status: number, message: string): GitHttpResponse {
  return {
    status,
    headers: { "Content-Type": "text/plain" },
    body: Buffer.from(`${status} ${message}\n`, "utf-8"),
  };
}

// ============================================================================
// 路由解析
// ============================================================================

/**
 * 检查请求是否为 v2 协议
 *
 * 通过 Git-Protocol 头检测客户端是否请求 v2 协议。
 */
function isV2Protocol(headers: Record<string, string>): boolean {
  const protocol = headers["git-protocol"] ?? "";
  return protocol.includes("version=2");
}

// ============================================================================
// 请求头处理
// ============================================================================

/**
 * 验证 info/refs 请求
 *
 * 返回错误响应或 null（验证通过）。
 */
function validateInfoRefsRequest(
  method: string,
  query: Record<string, string>,
): GitHttpResponse | null {
  if (method !== "GET") {
    return errorResponse(405, "Method Not Allowed: info/refs requires GET");
  }

  const service = query.service;
  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    return errorResponse(400, `Unknown service: ${service}`);
  }

  return null;
}

/**
 * 验证服务请求（/git-upload-pack 等）
 */
function validateServiceRequest(
  method: string,
  contentType: string | undefined,
): GitHttpResponse | null {
  if (method !== "POST") {
    return errorResponse(405, "Method Not Allowed: service requires POST");
  }

  if (!contentType || !contentType.startsWith("application/x-git-")) {
    return errorResponse(400, "Bad Content-Type for Git service request");
  }

  return null;
}

// ============================================================================
// 处理函数
// ============================================================================

/**
 * 处理 info/refs GET 请求
 *
 * 返回 v2 能力广告（当 Git-Protocol: version=2 头存在时）。
 */
function handleInfoRefs(_request: GitHttpRequest, service: string): GitHttpResponse {
  const advertise = serveV2Advertise(service);

  return {
    status: 200,
    headers: {
      "Content-Type": `application/x-git-${service}-advertisement`,
      "Cache-Control": "no-cache",
    },
    body: advertise,
  };
}

/**
 * 处理 /git-upload-pack POST 请求
 *
 * 解析 v2 命令并委托给对应的处理函数。
 */
async function handleUploadPack(
  request: GitHttpRequest,
  backend: RepositoryBackend,
): Promise<GitHttpResponse> {
  if (!request.body) {
    return errorResponse(400, "Request body is required");
  }

  const service = createV2UploadPackService(backend);

  let response: Buffer;
  try {
    response = service.handleCommand(request.body);
  } catch (err) {
    if (err instanceof V2ServeError) {
      return errorResponse(400, err.message);
    }
    throw err;
  }

  return {
    status: 200,
    headers: {
      "Content-Type": "application/x-git-upload-pack-result",
      "Cache-Control": "no-cache",
    },
    body: response,
  };
}

// ============================================================================
// 主处理函数
// ============================================================================

/**
 * 创建 Smart HTTP 处理函数
 *
 * 这是类似 git-http-backend 的核心入口。
 * 接收框架无关的 HTTP 请求，返回 HTTP 响应。
 *
 * @param backend - 仓库后端
 * @returns HTTP 处理函数
 *
 * @example
 * ```ts
 * // Bun.serve 示例
 * import { createSmartHttpHandler } from "nano-git/transport/server/smart-http";
 * import { openRepository } from "nano-git/repository/file";
 *
 * const handler = createSmartHttpHandler(openRepository("/repo"));
 *
 * Bun.serve({
 *   port: 8080,
 *   async fetch(req) {
 *     const url = new URL(req.url);
 *     const gitReq = {
 *       method: req.method,
 *       path: url.pathname,
 *       query: Object.fromEntries(url.searchParams),
 *       headers: Object.fromEntries(req.headers),
 *       body: Buffer.from(await req.arrayBuffer()),
 *     };
 *     const gitResp = await handler(gitReq);
 *     return new Response(gitResp.body, {
 *       status: gitResp.status,
 *       headers: gitResp.headers,
 *     });
 *   },
 * });
 * ```
 */
export function createSmartHttpHandler(backend: RepositoryBackend): SmartHttpHandler {
  return async (request: GitHttpRequest): Promise<GitHttpResponse> => {
    const { method, path, query, headers } = request;

    // 路由：info/refs（能力广告）
    if (path === "/info/refs" || path.endsWith("/info/refs")) {
      const validationError = validateInfoRefsRequest(method, query);
      if (validationError) return validationError;

      const service = query.service!;

      // v2 协议检测
      if (!isV2Protocol(headers)) {
        return errorResponse(
          400,
          "Only Git Wire Protocol v2 is supported. Set Git-Protocol: version=2 header.",
        );
      }

      return handleInfoRefs(request, service);
    }

    // 路由：/git-upload-pack（fetch / ls-refs 命令）
    if (path === "/git-upload-pack" || path.endsWith("/git-upload-pack")) {
      const validationError = validateServiceRequest(method, headers["content-type"]);
      if (validationError) return validationError;

      return handleUploadPack(request, backend);
    }

    // 路由：/git-receive-pack（push 命令 — 尚未实现）
    if (path === "/git-receive-pack" || path.endsWith("/git-receive-pack")) {
      return errorResponse(501, "git-receive-pack not yet implemented in server mode");
    }

    // 未知路由
    return errorResponse(404, `Not Found: ${path}`);
  };
}
