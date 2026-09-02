/**
 * Smart HTTP 传输层 — Receive-Pack 客户端
 *
 * 基于 Bun 内置 fetch() 的 Git Smart HTTP 协议 HTTP 适配器。
 * 仅提供 receive-pack（push）客户端，upload-pack（fetch）请使用 v2 协议。
 *
 * @see https://git-scm.com/docs/http-protocol
 */

import { toUint8Array } from "../../../bytes.ts";
import { GitError } from "../../../errors.ts";
import { parseRefAdvertisement, RefAdvertisementError } from "../../protocol/ref-advertisement.ts";
import { buildGitHttpAuthHeader } from "../http-auth.ts";

import type { GitErrorOptions } from "../../../errors.ts";
import type { HttpAuth } from "../../../remote/types.ts";
import type { RefAdvertisement, GitServiceTransport } from "../../protocol/types.ts";

// ============================================================================
// 错误类型
// ============================================================================

/**
 * Smart HTTP 传输错误选项
 */
export interface SmartHttpErrorOptions extends GitErrorOptions {
  readonly statusCode?: number;
  readonly url?: string;
}

/**
 * Smart HTTP 传输错误
 *
 * 当 HTTP 层面的传输出错时抛出（网络错误、非预期状态码等）。
 *
 * @example
 * ```ts
 * throw new SmartHttpError("request failed", { statusCode: 503, url, cause: err });
 * ```
 */
export class SmartHttpError extends GitError {
  readonly statusCode?: number;
  readonly url?: string;

  constructor(message: string, options?: SmartHttpErrorOptions) {
    super(
      `Smart HTTP error: ${message}${options?.statusCode !== undefined ? ` (status ${options.statusCode})` : ""}`,
      options,
    );
    this.name = "SmartHttpError";
    this.statusCode = options?.statusCode;
    this.url = options?.url;
  }
}

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Smart HTTP 认证配置
 */
export interface SmartHttpAuth {
  /** HTTP Basic 认证凭据 */
  readonly auth?: HttpAuth;
  /** 自定义请求头 */
  readonly headers?: Record<string, string>;
}

// ============================================================================
// HTTP 辅助函数
// ============================================================================

function applyAuthHeaders(
  base: Record<string, string>,
  options?: SmartHttpAuth,
): Record<string, string> {
  const result: Record<string, string> = {
    ...options?.headers,
  };
  // Git Smart HTTP 使用标准 Basic 认证；若与 headers.Authorization 并存，auth 优先
  if (options?.auth) {
    result["Authorization"] = buildGitHttpAuthHeader(options.auth.username, options.auth.password);
  }
  return { ...base, ...result };
}

async function readResponseBody(response: Response, context: string): Promise<Uint8Array> {
  try {
    return toUint8Array(await response.arrayBuffer());
  } catch (err: unknown) {
    throw new SmartHttpError(`Failed to read response body (${context})`, {
      cause: err,
      url: context,
    });
  }
}

function assertContentType(actual: string, expected: string, context: string): void {
  if (!actual.includes(expected)) {
    throw new SmartHttpError(
      `Unexpected content type: ${actual} (expected ${expected}) (${context})`,
      { url: context },
    );
  }
}

// ============================================================================
// Receive-Pack 客户端
// ============================================================================

/** receive-pack HTTP 端点配置 */
const RECEIVE_PACK_ADVERTISE_SERVICE = "git-receive-pack";
const RECEIVE_PACK_ADVERTISE_CONTENT_TYPE = "application/x-git-receive-pack-advertisement";
const RECEIVE_PACK_RPC_PATH = "/git-receive-pack";
const RECEIVE_PACK_RPC_CONTENT_TYPE = "application/x-git-receive-pack-request";
const RECEIVE_PACK_RESULT_CONTENT_TYPE = "application/x-git-receive-pack-result";

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
  const normalizedUrl = baseUrl.replace(/\/+$/, "");

  return {
    async advertise(): Promise<RefAdvertisement> {
      const url = `${normalizedUrl}/info/refs?service=${RECEIVE_PACK_ADVERTISE_SERVICE}`;

      let response: Response;
      try {
        response = await fetch(url, { headers: applyAuthHeaders({}, auth) });
      } catch (err: unknown) {
        throw new SmartHttpError(`Failed to fetch ref advertisement from ${url}`, {
          cause: err,
          url,
        });
      }

      if (!response.ok) {
        throw new SmartHttpError(`Failed to fetch ref advertisement from ${url}`, {
          statusCode: response.status,
          url,
        });
      }

      const contentType = response.headers.get("content-type") ?? "";
      assertContentType(contentType, RECEIVE_PACK_ADVERTISE_CONTENT_TYPE, url);

      const data = await readResponseBody(response, url);

      try {
        return parseRefAdvertisement(data, RECEIVE_PACK_ADVERTISE_SERVICE);
      } catch (err: unknown) {
        if (err instanceof RefAdvertisementError) {
          throw err;
        }
        throw new SmartHttpError("Failed to parse ref advertisement", { cause: err, url });
      }
    },

    async request(body: Uint8Array): Promise<Uint8Array> {
      const url = `${normalizedUrl}${RECEIVE_PACK_RPC_PATH}`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: applyAuthHeaders({ "Content-Type": RECEIVE_PACK_RPC_CONTENT_TYPE }, auth),
          body,
        });
      } catch (err: unknown) {
        throw new SmartHttpError(`Failed to POST RPC request to ${url}`, { cause: err, url });
      }

      if (!response.ok) {
        throw new SmartHttpError(`RPC request to ${url} failed`, {
          statusCode: response.status,
          url,
        });
      }

      const contentType = response.headers.get("content-type") ?? "";
      assertContentType(contentType, RECEIVE_PACK_RESULT_CONTENT_TYPE, url);

      return readResponseBody(response, url);
    },
  };
}
