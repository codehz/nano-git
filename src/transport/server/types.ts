/**
 * Smart HTTP 服务器端类型定义
 *
 * 基于标准 Web API 的 Request/Response，框架无关。
 * 任何支持 Web 标准的环境均可直接使用：
 * - Bun.serve / Deno.serve
 * - Cloudflare Workers
 * - Node.js 18+ (global This)
 * - 各框架的适配层（Hono、Express 等）
 */

/**
 * Smart HTTP 处理函数签名
 *
 * 接收标准 Request，返回标准 Response。
 * 纯函数风格，不绑定任何 HTTP 框架。
 *
 * @example
 * ```ts
 * const handler: SmartHttpHandler = async (req: Request) => {
 *   return new Response("OK", { status: 200 });
 * };
 * ```
 */
export type SmartHttpHandler = (request: Request) => Response | Promise<Response>;
