/**
 * receive-pack 服务编排器
 *
 * 聚合 Git 协议 v1 receive-pack 的服务端能力：
 * - ref 广告生成
 * - push 请求处理
 *
 * 底层协议实现细节仍保留在各子模块中，
 * 本文件仅提供协议无关的服务接口和工厂。
 */

import { advertiseReceivePack } from "./advertise.ts";
import { handleReceivePackRequest } from "./handler.ts";

import type { RepositoryBackend } from "../../../backend/types.ts";
import type { ReceivePackOptions } from "./types.ts";

/**
 * Receive-Pack 服务接口
 *
 * 提供协议无关的 receive-pack 能力：
 * - advertise(): 生成服务 ref 广告
 * - handleRequest(): 处理客户端请求
 */
export interface ReceivePackService {
  /**
   * 生成 ref 广告
   */
  advertise(): Buffer;

  /**
   * 处理请求
   *
   * @param body - 客户端请求体
   * @returns 服务端响应
   */
  handleRequest(body: Buffer): Buffer;
}

/**
 * 创建 Receive-Pack 服务实例
 *
 * @param backend - 仓库后端
 * @param options - 处理选项
 * @returns ReceivePackService 实例
 *
 * @example
 * ```ts
 * const service = createReceivePackService(backend);
 * const advertise = service.advertise();
 * const response = service.handleRequest(body);
 * ```
 */
export function createReceivePackService(
  backend: RepositoryBackend,
  options?: ReceivePackOptions,
): ReceivePackService {
  return {
    advertise(): Buffer {
      return advertiseReceivePack(backend);
    },

    handleRequest(body: Buffer): Buffer {
      return handleReceivePackRequest(backend, body, options);
    },
  };
}
