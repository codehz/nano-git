/**
 * Smart HTTP 服务器端类型定义
 *
 * 定义框架无关的 HTTP 请求/响应接口，
 * 使服务端 Git 协议处理可以脱离具体 HTTP 服务器使用。
 *
 * 设计目标：任何 HTTP 框架（Bun.serve、Node.js http、Express、Hono 等）
 * 只需将原生请求/响应适配为此接口即可使用 nano-git 的 Git HTTP 后端能力。
 *
 * @example
 * ```ts
 * // Bun.serve 适配
 * import type { GitHttpRequest, GitHttpResponse } from "nano-git/transport/server/types";
 *
 * const gitReq: GitHttpRequest = {
 *   method: req.method,
 *   path: new URL(req.url).pathname,
 *   query: Object.fromEntries(new URL(req.url).searchParams),
 *   headers: Object.fromEntries(req.headers),
 *   body: req.body ? Buffer.from(await req.arrayBuffer()) : null,
 * };
 * ```
 */

/**
 * Git HTTP 请求
 *
 * 比标准 Request 更精简，聚焦 Git 协议所需的字段。
 */
export interface GitHttpRequest {
  /** HTTP 方法（GET / POST） */
  readonly method: string;
  /** 请求路径（不含 query string），如 "/info/refs" */
  readonly path: string;
  /** 查询参数 */
  readonly query: Record<string, string>;
  /** 请求头（小写键） */
  readonly headers: Record<string, string>;
  /** 请求体 */
  readonly body: Buffer | null;
}

/**
 * Git HTTP 响应
 */
export interface GitHttpResponse {
  /** HTTP 状态码 */
  readonly status: number;
  /** 响应头 */
  readonly headers: Record<string, string>;
  /** 响应体 */
  readonly body: Buffer;
}

/**
 * Smart HTTP 处理函数签名
 *
 * 接收 Git HTTP 请求，返回 Git HTTP 响应。
 * 纯函数风格，不绑定任何 HTTP 框架。
 */
export type SmartHttpHandler = (request: GitHttpRequest) => Promise<GitHttpResponse>;
