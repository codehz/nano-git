/**
 * receive-pack 服务端模块
 *
 * 提供 Git Wire 协议 v1 receive-pack（push）服务端实现。
 *
 * 子模块划分：
 * - types.ts      — 类型定义、常量和错误类
 * - advertise.ts  — ref 广告生成（GET /info/refs）
 * - parse.ts      — 请求解析（POST body 命令解析）
 * - unpack.ts     — Packfile 解包
 * - report-status.ts — report-status 响应生成
 * - handler.ts    — 主处理函数（整合全流程）
 * - service.ts    — 服务编排器（工厂 + ReceivePackService）
 */

export { advertiseReceivePack } from "./advertise.ts";
export { parseReceivePackRequest } from "./parse.ts";
export { ReceivePackServiceError } from "./types.ts";
export { handleReceivePackRequest } from "./handler.ts";
export { createReceivePackService } from "./service.ts";

export type {
  ReceivePackCommand,
  ParsedReceivePackRequest,
  ReceivePackUpdateResult,
  ReceivePackOptions,
} from "./types.ts";
export type { ReceivePackService } from "./service.ts";
