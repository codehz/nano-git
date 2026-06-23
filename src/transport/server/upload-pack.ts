/**
 * Upload-Pack 服务编排器
 *
 * 聚合 Git Wire 协议的服务端 upload-pack 能力：
 * - 能力广告生成
 * - ls-refs / fetch 命令处理
 *
 * 协议实现细节（v2 协议原语）在 v2/serve.ts 中维护，
 * 本文件仅提供协议无关的服务接口和工厂。
 */

import {
  serveV2Advertise,
  parseV2Command,
  parseLsRefsArgs,
  generateLsRefsResponse,
  parseFetchArgs,
  generateFetchResponse,
  V2ServeError,
} from "../serve.ts";

import type { RepositoryBackend } from "../../repository/backend/types.ts";

/**
 * Upload-Pack 服务错误
 */
export class UploadPackError extends Error {
  constructor(message: string) {
    super(`upload-pack: ${message}`);
    this.name = "UploadPackError";
  }
}

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Upload-Pack 服务接口
 *
 * 提供协议无关的 upload-pack 能力:
 * - advertise(): 生成服务能力广告
 * - handleCommand(): 处理客户端命令请求
 */
export interface UploadPackService {
  /**
   * 生成能力广告
   *
   * @param service - 服务类型（如 "git-upload-pack"）
   */
  advertise(service: string): Buffer;

  /**
   * 处理命令请求
   *
   * @param body - 客户端请求体（pkt-line 编码）
   * @returns 服务端响应（pkt-line 编码）
   * @throws {UploadPackError} 命令不支持或参数不合法
   */
  handleCommand(body: Buffer): Buffer;
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Upload-Pack 服务实例
 *
 * @param backend - 仓库后端
 * @returns UploadPackService 实例
 *
 * @example
 * ```ts
 * const service = createUploadPackService(backend);
 * const advertise = service.advertise("git-upload-pack");
 * const response = service.handleCommand(body);
 * ```
 */
export function createUploadPackService(backend: RepositoryBackend): UploadPackService {
  return {
    advertise(service: string): Buffer {
      return serveV2Advertise(service);
    },

    handleCommand(body: Buffer): Buffer {
      const parsed = parseV2Command(body);

      try {
        switch (parsed.command) {
          case "ls-refs": {
            const options = parseLsRefsArgs(parsed.args);
            return generateLsRefsResponse(backend, options);
          }
          case "fetch": {
            const params = parseFetchArgs(parsed.args);
            return generateFetchResponse(backend, params);
          }
          default: {
            throw new UploadPackError(`unknown command: ${parsed.command}`);
          }
        }
      } catch (err) {
        if (err instanceof UploadPackError) throw err;
        if (err instanceof V2ServeError) {
          throw new UploadPackError(err.message);
        }
        throw err;
      }
    },
  };
}
