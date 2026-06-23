/**
 * Upload-Pack 服务端模块
 *
 * 提供 Git Wire 协议 v2 upload-pack 的命令处理原语与服务编排。
 *
 * 子模块划分：
 * - types.ts      — 类型定义、常量和错误类
 * - advertise.ts  — v2 能力广告生成（GET /info/refs）
 * - command.ts    — v2 命令请求解析
 * - ls-refs.ts    — ls-refs 命令响应生成
 * - fetch.ts      — fetch 命令响应生成
 * - service.ts    — 服务编排器（工厂 + UploadPackService）
 */

export { serveV2Advertise } from "./advertise.ts";
export { parseV2Command } from "./command.ts";
export { parseLsRefsArgs, generateLsRefsResponse } from "./ls-refs.ts";
export { parseFetchArgs, generateFetchResponse } from "./fetch.ts";
export { V2ServeError } from "./types.ts";
export { UploadPackError, createUploadPackService } from "./service.ts";

export type { ParsedV2Command } from "./command.ts";
export type { LsRefsServerOptions } from "./ls-refs.ts";
export type { FetchServerParams } from "./fetch.ts";
export type { UploadPackService } from "./service.ts";
