/**
 * Smart HTTP 传输层
 *
 * 基于 Bun 内置 fetch() 的 Git Smart HTTP 协议 HTTP 适配器。
 * 只负责 URL、认证、状态码与 content-type 校验，返回解析后的广告或原始 RPC body。
 *
 * @see https://git-scm.com/docs/http-protocol
 */

import { GitError } from "../core/errors.ts";
import { parseRefAdvertisement, RefAdvertisementError } from "./ref-advertisement.ts";

import type { RefAdvertisement, GitServiceTransport } from "./types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * Smart HTTP 传输错误
 *
 * 当 HTTP 层面的传输出错时抛出（网络错误、非预期状态码等）。
 */
export class SmartHttpError extends GitError {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(
      `Smart HTTP error: ${message}${statusCode !== undefined ? ` (status ${statusCode})` : ""}`,
    );
    this.name = "SmartHttpError";
  }
}

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Smart HTTP 认证配置
 */
export interface SmartHttpAuth {
  readonly token?: string;
  readonly headers?: Record<string, string>;
}

interface GitHttpServiceConfig {
  readonly advertiseService: "git-upload-pack" | "git-receive-pack";
  readonly advertiseContentType: string;
  readonly rpcPath: string;
  readonly rpcRequestContentType: string;
  readonly rpcResultContentType: string;
}

const UPLOAD_PACK_HTTP: GitHttpServiceConfig = {
  advertiseService: "git-upload-pack",
  advertiseContentType: "application/x-git-upload-pack-advertisement",
  rpcPath: "/git-upload-pack",
  rpcRequestContentType: "application/x-git-upload-pack-request",
  rpcResultContentType: "application/x-git-upload-pack-result",
};

const RECEIVE_PACK_HTTP: GitHttpServiceConfig = {
  advertiseService: "git-receive-pack",
  advertiseContentType: "application/x-git-receive-pack-advertisement",
  rpcPath: "/git-receive-pack",
  rpcRequestContentType: "application/x-git-receive-pack-request",
  rpcResultContentType: "application/x-git-receive-pack-result",
};

function applyAuthHeaders(
  base: Record<string, string>,
  auth?: SmartHttpAuth,
): Record<string, string> {
  const result: Record<string, string> = {
    ...auth?.headers,
  };
  if (auth?.token) {
    result["Authorization"] = `Bearer ${auth.token}`;
  }
  return { ...base, ...result };
}

async function readResponseBody(response: Response, context: string): Promise<Buffer> {
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    throw new SmartHttpError(
      `Failed to read response body (${context}): ${(err as Error).message}`,
    );
  }
}

function assertContentType(actual: string, expected: string, context: string): void {
  if (!actual.includes(expected)) {
    throw new SmartHttpError(
      `Unexpected content type: ${actual} (expected ${expected}) (${context})`,
    );
  }
}

function createGitServiceHttpClient(
  baseUrl: string,
  auth: SmartHttpAuth | undefined,
  config: GitHttpServiceConfig,
): GitServiceTransport {
  const normalizedUrl = baseUrl.replace(/\/+$/, "");

  return {
    async advertise(): Promise<RefAdvertisement> {
      const url = `${normalizedUrl}/info/refs?service=${config.advertiseService}`;

      let response: Response;
      try {
        response = await fetch(url, { headers: applyAuthHeaders({}, auth) });
      } catch (err) {
        throw new SmartHttpError(
          `Failed to fetch ref advertisement from ${url}: ${(err as Error).message}`,
        );
      }

      if (!response.ok) {
        throw new SmartHttpError(`Failed to fetch ref advertisement from ${url}`, response.status);
      }

      const contentType = response.headers.get("content-type") ?? "";
      assertContentType(contentType, config.advertiseContentType, url);

      const data = await readResponseBody(response, url);

      try {
        return parseRefAdvertisement(data, config.advertiseService);
      } catch (err) {
        if (err instanceof RefAdvertisementError) {
          throw err;
        }
        throw new SmartHttpError(`Failed to parse ref advertisement: ${(err as Error).message}`);
      }
    },

    async request(body: Buffer): Promise<Buffer> {
      const url = `${normalizedUrl}${config.rpcPath}`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: applyAuthHeaders({ "Content-Type": config.rpcRequestContentType }, auth),
          body,
        });
      } catch (err) {
        throw new SmartHttpError(`Failed to POST RPC request to ${url}: ${(err as Error).message}`);
      }

      if (!response.ok) {
        throw new SmartHttpError(`RPC request to ${url} failed`, response.status);
      }

      const contentType = response.headers.get("content-type") ?? "";
      assertContentType(contentType, config.rpcResultContentType, url);

      return readResponseBody(response, url);
    },
  };
}

/**
 * 创建 upload-pack HTTP 客户端
 *
 * @example
 * ```ts
 * const client = createUploadPackHttpClient("https://github.com/user/repo");
 * const adv = await client.advertise();
 * const raw = await client.request(body);
 * ```
 */
export function createUploadPackHttpClient(
  baseUrl: string,
  auth?: SmartHttpAuth,
): GitServiceTransport {
  return createGitServiceHttpClient(baseUrl, auth, UPLOAD_PACK_HTTP);
}

/**
 * 创建 receive-pack HTTP 客户端
 *
 * @example
 * ```ts
 * const client = createReceivePackHttpClient("https://github.com/user/repo");
 * const adv = await client.advertise();
 * const raw = await client.request(body);
 * ```
 */
export function createReceivePackHttpClient(
  baseUrl: string,
  auth?: SmartHttpAuth,
): GitServiceTransport {
  return createGitServiceHttpClient(baseUrl, auth, RECEIVE_PACK_HTTP);
}
