/**
 * Git Wire 协议 v1 服务端模块
 *
 * 提供 v1 协议的 receive-pack（push）服务端实现。
 *
 * 子模块划分：
 * - types.ts      — 类型定义、常量和错误类
 * - advertise.ts  — v1 ref 广告生成（GET /info/refs）
 * - parse.ts      — 请求解析（POST body 命令解析）
 * - unpack.ts     — Packfile 解包
 * - report-status.ts — report-status 响应生成
 * - handler.ts    — 主处理函数（整合全流程）
 * - service.ts    — 服务编排器（工厂 + ReceivePackService）
 */

export { serveV1Advertise } from "./advertise.ts";
export { parseV1ReceivePackRequest } from "./parse.ts";
export { V1ReceivePackError } from "./types.ts";
export { handleV1ReceivePush } from "./handler.ts";
export { createReceivePackService } from "./service.ts";

export type {
  V1ReceivePackCommand,
  ParsedV1ReceivePackRequest,
  V1RefUpdateResult,
  V1ReceivePackOptions,
} from "./types.ts";
export type { ReceivePackService } from "./service.ts";
