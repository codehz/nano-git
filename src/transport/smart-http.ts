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

import { parseRefAdvertisement, RefAdvertisementError } from "./ref-advertisement.ts";
import { extractPackfile, extractProgress, SideBandError } from "./side-band.ts";
import { parsePktLines } from "./pkt-line.ts";
import type { PktLineData } from "./pkt-line.ts";
import { parseReceivePackResult } from "./receive-pack-result.ts";
import type { RefAdvertisement, PushRefUpdate } from "./types.ts";
import { GitError } from "../core/errors.ts";

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
 */
export interface SmartHttpClient {
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
      // 先尝试提取 packfile（side-band 编码时提取 channel 1）
      // 如果提取失败（无 channel 1 数据），可能是纯 NAK/ACK 响应
      let packfile: Buffer;
      let progress: string[];

      try {
        packfile = extractPackfile(data);
        progress = extractProgress(data);
      } catch (_err) {
        // 非 side-band 响应（如纯 NAK），返回空 packfile
        packfile = Buffer.alloc(0);
        progress = [];
      }

      return { packfile, progress };
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

      try {
        const pktLines = parsePktLines(data);

        if (pktLines.length > 0 && pktLines[0]!.type === "data") {
          const firstPayload = (pktLines[0] as PktLineData).payload;
          if (
            firstPayload.length > 0 &&
            (firstPayload[0] === 0x01 || firstPayload[0] === 0x02 || firstPayload[0] === 0x03)
          ) {
            // Side-band 编码：从 channel 1 提取 report-status，从 channel 2 提取进度
            const reportStatusChunks: Buffer[] = [];

            for (const line of pktLines) {
              if (line.type !== "data") continue;
              const payload = line.payload;
              if (payload.length < 2) continue;

              const channel = payload[0]!;
              const frameData = payload.subarray(1);

              if (channel === 0x01) {
                // Channel 1: packfile 数据或 report-status 文本
                // report-status 行以 "ok " 或 "ng " 开头
                if (
                  frameData.length >= 3 &&
                  frameData[0] === 0x6f &&
                  frameData[1] === 0x6b &&
                  frameData[2] === 0x20 // "ok "
                ) {
                  // ok <ref-name>
                  const refName = frameData.subarray(3).toString("utf-8").trimEnd();
                  refUpdates.push({
                    refName,
                    oldHash: null,
                    newHash: null,
                    success: true,
                    forced: false,
                  });
                } else if (
                  frameData.length >= 3 &&
                  frameData[0] === 0x6e &&
                  frameData[1] === 0x67 &&
                  frameData[2] === 0x20 // "ng "
                ) {
                  // ng <ref-name> <error-msg>
                  const rest = frameData.subarray(3).toString("utf-8").trimEnd();
                  const spaceIndex = rest.indexOf(" ");
                  if (spaceIndex !== -1) {
                    refUpdates.push({
                      refName: rest.substring(0, spaceIndex),
                      oldHash: null,
                      newHash: null,
                      success: false,
                      error: rest.substring(spaceIndex + 1),
                      forced: false,
                    });
                  } else {
                    // 格式异常，整段作为 report-status 数据收集
                    reportStatusChunks.push(frameData);
                  }
                } else if (
                  frameData.length >= 6 &&
                  frameData.subarray(0, 6).toString("utf-8") === "unpack"
                ) {
                  // "unpack ok" / "unpack <error>" — 由上层编排函数处理
                  continue;
                } else {
                  // 其他 channel 1 数据（packfile 等），跳过
                  continue;
                }
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

            // 如果通过直接解析未获得 report-status，尝试用 parseReceivePackResult 解析收集到的数据
            if (refUpdates.length === 0 && reportStatusChunks.length > 0) {
              // 重建 pkt-line 格式
              const reconstructed = Buffer.concat(
                reportStatusChunks.map((chunk) => {
                  const len = chunk.length + 4;
                  const prefix = len.toString(16).padStart(4, "0").toUpperCase();
                  return Buffer.concat([Buffer.from(prefix, "utf-8"), chunk]);
                }),
              );
              refUpdates = parseReceivePackResult(reconstructed);
            }
          } else {
            // 非 side-band：数据为纯 pkt-line report-status
            refUpdates = parseReceivePackResult(data);
          }
        }
      } catch (err) {
        // 解析失败时仍返回原始数据，不阻断整个流程
        if (err instanceof SmartHttpError) {
          throw err;
        }
        // 非致命解析错误，返回空结果
      }

      return { data, refUpdates, progress };
    },
  };
}
