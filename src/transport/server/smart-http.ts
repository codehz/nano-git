/**
 * Smart HTTP 后端适配器
 *
 * 类似 git-http-backend 的职责，但基于标准 Web API 的 Request/Response：
 * - 接收标准 Request，返回标准 Response
 * - 框架无关（Bun、Deno、Node.js、Cloudflare Workers 等均可直接使用）
 * - 无自定义 HTTP 抽象层
 *
 * 当前支持：
 * - upload-pack（fetch + ls-refs）
 * - receive-pack（push）
 *
 * 路由：
 * - GET /info/refs?service=git-upload-pack   → v2 能力广告
 * - GET /info/refs?service=git-receive-pack  → v1 ref 广告
 * - POST /git-upload-pack                    → ls-refs / fetch 命令
 * - POST /git-receive-pack                   → receive-pack（push）处理
 *
 * @see https://git-scm.com/docs/git-http-backend
 */

import { serveV1Advertise, handleV1ReceivePush } from "../server/receive-pack/receive-pack.ts";
import { createUploadPackService, UploadPackError } from "./upload-pack.ts";
import { serveV2Advertise } from "./upload-pack/serve.ts";

import type { RepositoryBackend } from "../../backend/types.ts";
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
 * 根据 service 类型返回相应的 ref 广告：
 * - git-upload-pack：返回 v2 能力广告
 * - git-receive-pack：始终返回 v1 ref 广告
 *
 * @param service - 服务类型（git-upload-pack 或 git-receive-pack）
 * @param _useV2 - 是否使用 v2 协议（仅 upload-pack 生效）
 * @param backend - 仓库后端（v1 广告需要）
 */
function handleInfoRefs(service: string, useV2: boolean, backend: RepositoryBackend): Response {
  const isReceivePack = service === "git-receive-pack";

  // git-receive-pack 始终走 v1 广告（v2 receive-pack 未实现）
  if (isReceivePack) {
    const advertise = serveV1Advertise(backend);
    return new Response(advertise, {
      status: 200,
      headers: {
        "Content-Type": "application/x-git-receive-pack-advertisement",
        "Cache-Control": "no-cache",
      },
    });
  }

  // v2 广告（git-upload-pack）
  const advertise = serveV2Advertise(service);
  const contentType = service.startsWith("git-")
    ? `application/x-${service}-advertisement`
    : `application/x-git-${service}-advertisement`;

  return new Response(advertise, {
    status: 200,
    headers: {
      "Content-Type": contentType,
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

  const service = createUploadPackService(backend);

  let response: Buffer;
  try {
    response = service.handleCommand(body);
  } catch (err) {
    if (err instanceof UploadPackError) {
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

    // 路由：info/refs（能力广告 / ref 广告）
    if (path === "/info/refs" || path.endsWith("/info/refs")) {
      const service = url.searchParams.get("service");
      const validationError = validateInfoRefsRequest(method, service);
      if (validationError) return validationError;

      const gitProtocol = request.headers.get("git-protocol") ?? "";
      const isV2 = gitProtocol.includes("version=2");

      // git-upload-pack 只支持 v2
      if (service === "git-upload-pack" && !isV2) {
        return errorResponse(
          400,
          "Only Git Wire Protocol v2 is supported for fetch. Set Git-Protocol: version=2 header.",
        );
      }

      // git-receive-pack 支持 v1 和 v2
      return handleInfoRefs(service!, isV2, backend);
    }

    // 路由：/git-upload-pack（fetch / ls-refs 命令 — v2）
    if (path === "/git-upload-pack" || path.endsWith("/git-upload-pack")) {
      const validationError = validateServiceRequest(method, request.headers.get("content-type"));
      if (validationError) return validationError;

      const body = Buffer.from(await request.arrayBuffer());
      return handleUploadPack(body, backend);
    }

    // 路由：/git-receive-pack（push 命令 — v1 receive-pack）
    if (path === "/git-receive-pack" || path.endsWith("/git-receive-pack")) {
      const validationError = validateServiceRequest(method, request.headers.get("content-type"));
      if (validationError) return validationError;

      const body = Buffer.from(await request.arrayBuffer());
      const response = handleV1ReceivePush(backend, body);

      return new Response(response, {
        status: 200,
        headers: {
          "Content-Type": "application/x-git-receive-pack-result",
          "Cache-Control": "no-cache",
        },
      });
    }

    // 未知路由
    return errorResponse(404, `Not Found: ${path}`);
  };
}
