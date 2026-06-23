/**
 * Smart HTTP 后端适配器
 *
 * 类似 git-http-backend 的职责，但基于标准 Web API 的 Request/Response：
 * - 接收标准 Request，返回标准 Response
 * - 框架无关（Bun、Deno、Node.js、Cloudflare Workers 等均可直接使用）
 * - 无自定义 HTTP 抽象层
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
import type { SmartHttpHandler } from "./types.ts";

// ============================================================================
// 错误响应
// ============================================================================

/**
 * 创建 HTTP 错误响应
 */
function errorResponse(status: number, message: string): Response {
  return new Response(`${status} ${message}\n`, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

// ============================================================================
// 请求解析辅助
// ============================================================================

/**
 * 验证 info/refs 请求
 */
function validateInfoRefsRequest(method: string, service: string | null): Response | null {
  if (method !== "GET") {
    return errorResponse(405, "Method Not Allowed: info/refs requires GET");
  }

  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    return errorResponse(400, `Unknown service: ${service}`);
  }

  return null;
}

/**
 * 验证服务请求（/git-upload-pack 等）
 */
function validateServiceRequest(method: string, contentType: string | null): Response | null {
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
 * 返回 v2 能力广告。
 */
function handleInfoRefs(service: string): Response {
  const advertise = serveV2Advertise(service);

  return new Response(advertise, {
    status: 200,
    headers: {
      "Content-Type": `application/x-git-${service}-advertisement`,
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * 处理 /git-upload-pack POST 请求
 */
async function handleUploadPack(body: Buffer, backend: RepositoryBackend): Promise<Response> {
  if (body.length === 0) {
    return errorResponse(400, "Request body is required");
  }

  const service = createV2UploadPackService(backend);

  let response: Buffer;
  try {
    response = service.handleCommand(body);
  } catch (err) {
    if (err instanceof V2ServeError) {
      return errorResponse(400, err.message);
    }
    throw err;
  }

  return new Response(response, {
    status: 200,
    headers: {
      "Content-Type": "application/x-git-upload-pack-result",
      "Cache-Control": "no-cache",
    },
  });
}

// ============================================================================
// 主处理函数
// ============================================================================

/**
 * 创建 Smart HTTP 处理函数
 *
 * 类似 git-http-backend 的核心入口。
 * 接收标准 Request，返回标准 Response，框架无关。
 *
 * @param backend - 仓库后端
 * @returns HTTP 处理函数
 *
 * @example
 * ```ts
 * // Bun.serve — 直接作为 fetch 处理器
 * import { createSmartHttpHandler } from "nano-git/transport/server/smart-http";
 * import { openRepository } from "nano-git/repository/file";
 * Bun.serve({ port: 8080, fetch: createSmartHttpHandler(openRepository("/repo")) });
 *
 * // Node.js http
 * import { createServer } from "node:http";
 * const handler = createSmartHttpHandler(openRepository("/repo"));
 * createServer(async (req, res) => {
 *   const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
 *   const body = await new Promise<Buffer>((resolve) => {
 *     const chunks: Buffer[] = [];
 *     req.on("data", (c) => chunks.push(c));
 *     req.on("end", () => resolve(Buffer.concat(chunks)));
 *   });
 *   const response = await handler(new Request(url, {
 *     method: req.method,
 *     headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
 *     body: req.method === "POST" ? body : undefined,
 *   }));
 *   res.writeHead(response.status, Object.fromEntries(response.headers));
 *   res.end(Buffer.from(await response.arrayBuffer()));
 * }).listen(8080);
 *
 * // Cloudflare Workers / Deno
 * export default { fetch: createSmartHttpHandler(openRepository("./repo")) };
 * ```
 */
export function createSmartHttpHandler(backend: RepositoryBackend): SmartHttpHandler {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const { pathname: path } = url;
    const method = request.method;

    // 路由：info/refs（能力广告）
    if (path === "/info/refs" || path.endsWith("/info/refs")) {
      const service = url.searchParams.get("service");
      const validationError = validateInfoRefsRequest(method, service);
      if (validationError) return validationError;

      // v2 协议检测
      const gitProtocol = request.headers.get("git-protocol") ?? "";
      if (!gitProtocol.includes("version=2")) {
        return errorResponse(
          400,
          "Only Git Wire Protocol v2 is supported. Set Git-Protocol: version=2 header.",
        );
      }

      return handleInfoRefs(service!);
    }

    // 路由：/git-upload-pack（fetch / ls-refs 命令）
    if (path === "/git-upload-pack" || path.endsWith("/git-upload-pack")) {
      const validationError = validateServiceRequest(method, request.headers.get("content-type"));
      if (validationError) return validationError;

      const body = Buffer.from(await request.arrayBuffer());
      return handleUploadPack(body, backend);
    }

    // 路由：/git-receive-pack（push 命令 — 尚未实现）
    if (path === "/git-receive-pack" || path.endsWith("/git-receive-pack")) {
      return errorResponse(501, "git-receive-pack not yet implemented in server mode");
    }

    // 未知路由
    return errorResponse(404, `Not Found: ${path}`);
  };
}
