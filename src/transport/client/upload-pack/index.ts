/**
 * Upload-Pack 客户端模块
 *
 * 提供 Git Wire 协议 v2 的 upload-pack 客户端能力：
 * - 能力广告解析
 * - ls-refs / fetch / object-info 命令
 * - Smart HTTP 传输适配器
 */

export {
  parseV2CapabilityAdvertisement,
  hasCommand,
  getCommandFeatures,
  V2CapabilityError,
} from "./capability-advertisement.ts";
export { createV2HttpTransport, V2SmartHttpError } from "./http.ts";
export { lsRefs, parseLsRefsResponse, lsRefsToRefAdvertisement, LsRefsError } from "./ls-refs.ts";
export type { LsRefsOptions, LsRefsEntry } from "./ls-refs.ts";
export { v2Fetch, v2FetchObjects, parseV2FetchResponse, V2FetchError } from "./fetch.ts";
export type { V2FetchParams } from "./fetch.ts";
export { objectInfo, parseObjectInfoResponse, ObjectInfoError } from "./object-info.ts";
export type { ObjectInfoResult, ObjectInfoQueryResult } from "./object-info.ts";
export type {
  V2CommandEntry,
  V2CapabilityAdvertisement,
  V2GitServiceTransport,
  V2FetchRequest,
  V2FetchResponse,
  ObjectInfoEntry,
  ObjectInfoResponse,
} from "./types.ts";
