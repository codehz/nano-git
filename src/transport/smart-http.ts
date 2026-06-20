/**
 * Smart HTTP 传输层
 *
 * 基于 Bun 内置 fetch() 的 Git Smart HTTP 协议传输实现。
 *
 * 提供两个核心操作：
 * - getRefAdvertisement: 获取远程仓库的引用列表和服务端能力
 * - postUploadPack: 发送 want/have 请求并获取 packfile 数据
 *
 * @see https://git-scm.com/docs/http-protocol
 */

import { parseRefAdvertisement, RefAdvertisementError } from "./ref-advertisement.ts";
import { extractPackfile, extractProgress, SideBandError } from "./side-band.ts";
import type { RefAdvertisement } from "./types.ts";
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

/**
 * Smart HTTP 客户端接口
 *
 * 封装 Git Smart HTTP 协议的两个核心端点。
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
}

/**
 * 创建 Smart HTTP 客户端
 *
 * @param baseUrl - 远程仓库的 base URL（如 "https://github.com/user/repo"）
 * @returns SmartHttpClient 实例
 *
 * @example
 * ```ts
 * const client = createSmartHttpClient("https://github.com/user/repo");
 * const adv = await client.getRefAdvertisement();
 * const { packfile } = await client.postUploadPack(body);
 * ```
 */
export function createSmartHttpClient(baseUrl: string): SmartHttpClient {
  // 去除末尾斜杠
  const normalizedUrl = baseUrl.replace(/\/+$/, "");

  return {
    async getRefAdvertisement(): Promise<RefAdvertisement> {
      const url = `${normalizedUrl}/info/refs?service=git-upload-pack`;

      let response: Response;
      try {
        response = await fetch(url);
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
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-git-upload-pack-request",
          },
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
  };
}
