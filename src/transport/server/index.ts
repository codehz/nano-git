/**
 * Smart HTTP 服务器模块
 *
 * 提供基于标准 Web API 的 Git HTTP 后端能力，
 * 类似 git-http-backend 但以纯 TypeScript 接口形式。
 *
 * 核心入口：createSmartHttpHandler
 * - 接收标准 Request → 返回标准 Response
 * - 框架无关（Bun、Deno、Node.js、Cloudflare Workers 等均可直接使用）
 *
 * 当前支持：
 * - Git Wire 协议 v2 upload-pack（ls-refs + fetch）
 * - Git Wire 协议 v1 receive-pack（push）
 */

export { createSmartHttpHandler } from "./smart-http.ts";

export type { SmartHttpHandler } from "./types.ts";
