/**
 * Smart HTTP 服务器模块
 *
 * 提供框架无关的 Git HTTP 后端能力，
 * 类似 git-http-backend 但以纯 TypeScript 接口形式。
 *
 * 核心入口：createSmartHttpHandler
 * - 接收 GitHttpRequest → 返回 GitHttpResponse
 * - 不依赖任何 HTTP 框架
 * - 可便捷接入 Bun.serve、Node.js http、Express 等
 *
 * 当前支持：
 * - Git Wire 协议 v2 upload-pack（ls-refs + fetch）
 */

export { createSmartHttpHandler } from "./smart-http.ts";

export type { GitHttpRequest, GitHttpResponse, SmartHttpHandler } from "./types.ts";
