/**
 * Smart HTTP 传输层 — Receive-Pack 客户端
 *
 * 基于 Bun 内置 fetch() 的 Git Smart HTTP 协议 HTTP 适配器。
 * 仅提供 receive-pack（push）客户端，upload-pack（fetch）请使用 v2 协议。
 *
 * @see https://git-scm.com/docs/http-protocol
 */

import { GitError } from "../../../core/errors.ts";
import { parseRefAdvertisement, RefAdvertisementError } from "../../protocol/ref-advertisement.ts";

import type { RefAdvertisement, GitServiceTransport } from "../../protocol/types.ts";

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

// ============================================================================
// HTTP 辅助函数
// ============================================================================

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
  } catch (err: unknown) {
    throw new SmartHttpError(
      `Failed to read response body (${context}): ${err instanceof Error ? err.message : String(err)}`,
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
        throw new SmartHttpError(
          `Failed to fetch ref advertisement from ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!response.ok) {
        throw new SmartHttpError(`Failed to fetch ref advertisement from ${url}`, response.status);
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
        throw new SmartHttpError(
          `Failed to parse ref advertisement: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async request(body: Buffer): Promise<Buffer> {
      const url = `${normalizedUrl}${RECEIVE_PACK_RPC_PATH}`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: applyAuthHeaders({ "Content-Type": RECEIVE_PACK_RPC_CONTENT_TYPE }, auth),
          body,
        });
      } catch (err: unknown) {
        throw new SmartHttpError(
          `Failed to POST RPC request to ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!response.ok) {
        throw new SmartHttpError(`RPC request to ${url} failed`, response.status);
      }

      const contentType = response.headers.get("content-type") ?? "";
      assertContentType(contentType, RECEIVE_PACK_RESULT_CONTENT_TYPE, url);

      return readResponseBody(response, url);
    },
  };
}
