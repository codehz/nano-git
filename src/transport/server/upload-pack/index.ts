/**
 * Upload-Pack 服务端模块
 *
 * 提供 Git Wire 协议 v2 upload-pack 的命令处理原语与服务编排。
 *
 * 子模块划分：
 * - types.ts      — 类型定义、常量和错误类
 * - advertise.ts  — 能力广告生成（GET /info/refs）
 * - command.ts    — 命令请求解析
 * - ls-refs.ts    — ls-refs 命令响应生成
 * - fetch.ts      — fetch 命令响应生成
 * - service.ts    — 服务编排器（工厂 + UploadPackService）
 */

export { advertiseUploadPack } from "./advertise.ts";
export { parseCommandRequest } from "./command.ts";
export { parseLsRefsArgs, generateLsRefsResponse } from "./ls-refs.ts";
export { parseFetchArgs, generateFetchResponse } from "./fetch.ts";
export { UploadPackServiceError } from "./types.ts";
export { createUploadPackService } from "./service.ts";

export type { ParsedCommandRequest } from "./command.ts";
export type { LsRefsServerOptions } from "./ls-refs.ts";
export type { FetchServerParams } from "./fetch.ts";
export type { UploadPackService } from "./service.ts";
