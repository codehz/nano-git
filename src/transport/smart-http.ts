/**
 * Smart HTTP 传输层
 *
 * 基于 Bun 内置 fetch() 的 Git Smart HTTP 协议传输实现。
 *
 * 提供四个核心操作：
 * - getRefAdvertisement: 获取远程仓库的引用列表和服务端能力
 * - postUploadPack: 发送 want/have 请求并获取 packfile 数据
 * - getReceivePackRefs: 获取 receive-pack 的 ref 广告
 * - postReceivePack: 发送 push 命令和 packfile 并获取响应
 *
 * @see https://git-scm.com/docs/http-protocol
 */

import { GitError } from "../core/errors.ts";
import { parsePktLines, PktLineError } from "./pkt-line.ts";
import { parseReceivePackResult } from "./receive-pack-result.ts";
import { parseRefAdvertisement, RefAdvertisementError } from "./ref-advertisement.ts";
import {
  extractPackfile,
  extractProgress,
  extractRawPackfile,
  extractSideBandFatal,
  SideBandError,
} from "./side-band.ts";

import type { PktLineData } from "./pkt-line.ts";
import type { RefAdvertisement, PushRefUpdate, RemoteTransport } from "./types.ts";

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

/** upload-pack 响应结果 */
export interface UploadPackResult {
  /** 原始响应体 */
  data: Buffer;
  /** 完整的 packfile 数据 */
  packfile: Buffer;
  /** 服务端推送的进度消息列表 */
  progress: string[];
}

/** receive-pack HTTP 响应结果 */
export interface ReceivePackHttpResult {
  /** 原始响应体 */
  data: Buffer;
  /** report-status 更新列表 */
  refUpdates: PushRefUpdate[];
  /** 进度消息 */
  progress: string[];
}

/**
 * Smart HTTP 认证配置
 *
 * 控制向远程请求注入的认证信息。
 */
export interface SmartHttpAuth {
  /** Bearer Token，设置为 `Authorization: Bearer <token>` */
  token?: string;
  /** 自定义请求头，与 token 合并（token 优先转为 Authorization 头） */
  headers?: Record<string, string>;
}

/**
 * 合并认证配置到请求头中
 *
 * token 优先转为 `Authorization: Bearer <token>`，然后合并自定义 headers。
 */
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

/**
 * Smart HTTP 客户端接口
 *
 * 封装 Git Smart HTTP 协议的四个核心端点。
 * 实现 RemoteTransport 接口，允许作为 push/fetch 的传输层注入。
 */
export interface SmartHttpClient extends RemoteTransport {
  /**
   * 获取远程仓库的引用广告
   *
   * 对应 GET /info/refs?service=git-upload-pack
   */
  getRefAdvertisement(): Promise<RefAdvertisement>;

  /**
   * 发送 upload-pack 请求并获取响应
   *
   * 对应 POST /git-upload-pack
   *
   * @param body - pkt-line 编码的请求 body（由 buildUploadPackRequest 生成）
   */
  postUploadPack(body: Buffer): Promise<UploadPackResult>;

  /**
   * 获取 receive-pack 的 ref 广告
   *
   * 对应 GET /info/refs?service=git-receive-pack
   */
  getReceivePackRefs(): Promise<RefAdvertisement>;

  /**
   * 发送 receive-pack 请求并获取响应
   *
   * 对应 POST /git-receive-pack
   *
   * @param body - pkt-line 编码的请求 body（由 buildReceivePackRequest 生成）
   */
  postReceivePack(body: Buffer): Promise<ReceivePackHttpResult>;
}

/**
 * 创建 Smart HTTP 客户端
 *
 * @param baseUrl - 远程仓库的 base URL（如 "https://github.com/user/repo"）
 * @param auth - 可选认证配置（token / 自定义 headers）
 * @returns SmartHttpClient 实例
 *
 * @example
 * ```ts
 * const client = createSmartHttpClient("https://github.com/user/repo");
 * const adv = await client.getRefAdvertisement();
 *
 * // 带认证
 * const authed = createSmartHttpClient("https://github.com/user/repo", {
 *   token: "ghp_xxx",
 * });
 * const { packfile } = await authed.postUploadPack(body);
 * ```
 */
export function createSmartHttpClient(baseUrl: string, auth?: SmartHttpAuth): SmartHttpClient {
  // 去除末尾斜杠
  const normalizedUrl = baseUrl.replace(/\/+$/, "");

  return {
    async getRefAdvertisement(): Promise<RefAdvertisement> {
      const url = `${normalizedUrl}/info/refs?service=git-upload-pack`;

      let response: Response;
      try {
        const headers = applyAuthHeaders({}, auth);
        response = await fetch(url, { headers });
      } catch (err) {
        throw new SmartHttpError(
          `Failed to fetch ref advertisement from ${url}: ${(err as Error).message}`,
        );
      }

      if (!response.ok) {
        throw new SmartHttpError(`Failed to fetch ref advertisement from ${url}`, response.status);
      }

      const contentType = response.headers.get("content-type") ?? "";
      const expectedType = "application/x-git-upload-pack-advertisement";
      if (!contentType.includes(expectedType)) {
        throw new SmartHttpError(
          `Unexpected content type: ${contentType} (expected ${expectedType})`,
        );
      }

      let data: Buffer;
      try {
        data = Buffer.from(await response.arrayBuffer());
      } catch (err) {
        throw new SmartHttpError(`Failed to read response body: ${(err as Error).message}`);
      }

      try {
        return parseRefAdvertisement(data, "git-upload-pack");
      } catch (err) {
        if (err instanceof RefAdvertisementError) {
          throw err;
        }
        throw new SmartHttpError(`Failed to parse ref advertisement: ${(err as Error).message}`);
      }
    },

    async postUploadPack(body: Buffer): Promise<UploadPackResult> {
      const url = `${normalizedUrl}/git-upload-pack`;

      let response: Response;
      try {
        const headers = applyAuthHeaders(
          {
            "Content-Type": "application/x-git-upload-pack-request",
          },
          auth,
        );
        response = await fetch(url, {
          method: "POST",
          headers,
          body,
        });
      } catch (err) {
        throw new SmartHttpError(
          `Failed to POST upload-pack request to ${url}: ${(err as Error).message}`,
        );
      }

      if (!response.ok) {
        throw new SmartHttpError(`upload-pack request to ${url} failed`, response.status);
      }

      const contentType = response.headers.get("content-type") ?? "";
      const expectedType = "application/x-git-upload-pack-result";
      if (!contentType.includes(expectedType)) {
        throw new SmartHttpError(
          `Unexpected content type: ${contentType} (expected ${expectedType})`,
        );
      }

      let data: Buffer;
      try {
        data = Buffer.from(await response.arrayBuffer());
      } catch (err) {
        throw new SmartHttpError(`Failed to read response body: ${(err as Error).message}`);
      }

      // 响应可能是 side-band 编码或纯 pkt-line
      // 先检查 side-band channel 3 致命错误
      const fatalMsg = extractSideBandFatal(data);
      if (fatalMsg !== null) {
        throw new SmartHttpError(`Server reported fatal error: ${fatalMsg}`);
      }

      // 先尝试提取 packfile（side-band 编码时提取 channel 1）
      // 如果提取失败（无 channel 1 数据），可能是纯 NAK/ACK 响应
      let packfile: Buffer;
      let progress: string[];

      try {
        packfile = extractPackfile(data);
        progress = extractProgress(data);
      } catch (err) {
        if (err instanceof PktLineError && err.message.includes("Invalid pkt-line length")) {
          // 非 side-band 响应（如 NAK + 原始 packfile），回退到原始 packfile 提取
          try {
            packfile = extractRawPackfile(data);
          } catch {
            packfile = Buffer.alloc(0);
          }
          progress = [];
        } else if (err instanceof SideBandError) {
          // side-band 响应但无 packfile 数据（如协商中间轮次），返回空 packfile
          packfile = Buffer.alloc(0);
          progress = [];
        } else {
          // 截断或其他协议损坏应立即报错，而非静默降级
          throw new SmartHttpError(
            `Failed to parse upload-pack response: ${(err as Error).message}`,
          );
        }
      }

      return { data, packfile, progress };
    },

    async getReceivePackRefs(): Promise<RefAdvertisement> {
      const url = `${normalizedUrl}/info/refs?service=git-receive-pack`;

      let response: Response;
      try {
        const headers = applyAuthHeaders({}, auth);
        response = await fetch(url, { headers });
      } catch (err) {
        throw new SmartHttpError(
          `Failed to fetch receive-pack refs from ${url}: ${(err as Error).message}`,
        );
      }

      if (!response.ok) {
        throw new SmartHttpError(`Failed to fetch receive-pack refs from ${url}`, response.status);
      }

      const contentType = response.headers.get("content-type") ?? "";
      const expectedType = "application/x-git-receive-pack-advertisement";
      if (!contentType.includes(expectedType)) {
        throw new SmartHttpError(
          `Unexpected content type: ${contentType} (expected ${expectedType})`,
        );
      }

      let data: Buffer;
      try {
        data = Buffer.from(await response.arrayBuffer());
      } catch (err) {
        throw new SmartHttpError(`Failed to read response body: ${(err as Error).message}`);
      }

      try {
        return parseRefAdvertisement(data, "git-receive-pack");
      } catch (err) {
        if (err instanceof RefAdvertisementError) {
          throw err;
        }
        throw new SmartHttpError(`Failed to parse receive-pack refs: ${(err as Error).message}`);
      }
    },

    async postReceivePack(body: Buffer): Promise<ReceivePackHttpResult> {
      const url = `${normalizedUrl}/git-receive-pack`;

      let response: Response;
      try {
        const headers = applyAuthHeaders(
          {
            "Content-Type": "application/x-git-receive-pack-request",
          },
          auth,
        );
        response = await fetch(url, {
          method: "POST",
          headers,
          body,
        });
      } catch (err) {
        throw new SmartHttpError(
          `Failed to POST receive-pack request to ${url}: ${(err as Error).message}`,
        );
      }

      if (!response.ok) {
        throw new SmartHttpError(`receive-pack request to ${url} failed`, response.status);
      }

      const contentType = response.headers.get("content-type") ?? "";
      const expectedType = "application/x-git-receive-pack-result";
      if (!contentType.includes(expectedType)) {
        throw new SmartHttpError(
          `Unexpected content type: ${contentType} (expected ${expectedType})`,
        );
      }

      let data: Buffer;
      try {
        data = Buffer.from(await response.arrayBuffer());
      } catch (err) {
        throw new SmartHttpError(`Failed to read response body: ${(err as Error).message}`);
      }

      // 判断响应是否为 side-band 编码
      // 如果第一个 pkt-line 数据帧的 payload 首字节是 0x01/0x02/0x03，则为 side-band
      let progress: string[] = [];
      let refUpdates: PushRefUpdate[] = [];

      const pktLines = parsePktLines(data);

      if (pktLines.length > 0 && pktLines[0]!.type === "data") {
        const firstPayload = (pktLines[0] as PktLineData).payload;
        if (
          firstPayload.length > 0 &&
          (firstPayload[0] === 0x01 || firstPayload[0] === 0x02 || firstPayload[0] === 0x03)
        ) {
          // Side-band 编码：收集 channel 1 数据统一用 parseReceivePackResult 解析
          const reportStatusChunks: Buffer[] = [];

          for (const line of pktLines) {
            if (line.type !== "data") continue;
            const payload = line.payload;
            if (payload.length < 2) continue;

            const channel = payload[0]!;
            const frameData = payload.subarray(1);

            if (channel === 0x01) {
              // Channel 1: report-status 数据（pkt-line 编码）
              // 收集所有 channel 1 数据后用 parseReceivePackResult 统一解析，
              // 避免内联逐行解析在跨 pkt-line 分片时遗漏状态行
              reportStatusChunks.push(frameData);
            } else if (channel === 0x02) {
              // Channel 2: 进度消息
              progress.push(frameData.toString("utf-8").trimEnd());
            } else if (channel === 0x03) {
              // Channel 3: 致命错误
              throw new SmartHttpError(
                `Server reported error: ${frameData.toString("utf-8").trimEnd()}`,
              );
            }
          }

          // 统一用 parseReceivePackResult 解析 report-status
          if (reportStatusChunks.length > 0) {
            const reconstructed = Buffer.concat(reportStatusChunks);
            refUpdates = parseReceivePackResult(reconstructed);
          }
        } else {
          // 非 side-band：数据为纯 pkt-line report-status
          refUpdates = parseReceivePackResult(data);
        }
      }

      return { data, refUpdates, progress };
    },
  };
}
