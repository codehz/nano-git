/**
 * Git Wire 协议 v2 模块
 *
 * 导出所有 v2 协议相关的类型、解析函数、命令实现和检测工具。
 */

export type {
  V2CapabilityAdvertisement,
  V2CommandEntry,
  V2GitServiceTransport,
  LsRefsEntry,
  V2FetchRequest,
  V2FetchResponse,
  V2PushRequest,
  ObjectInfoEntry,
  ObjectInfoResponse,
} from "./types.ts";

export {
  parseV2CapabilityAdvertisement,
  hasCommand,
  getCommandFeatures,
  V2CapabilityError,
} from "./capability-advert.ts";

export { detectProtocol } from "./detect.ts";
export type { ProtocolDetectResult } from "./detect.ts";

export { createV2HttpTransport, V2SmartHttpError } from "./smart-http.ts";

export { lsRefs, parseLsRefsResponse, lsRefsToRefAdvertisement, LsRefsError } from "./ls-refs.ts";
export type { LsRefsOptions } from "./ls-refs.ts";

export {
  v2Fetch,
  v2FetchObjects,
  negotiateV2Fetch,
  parseV2FetchResponse,
  V2FetchError,
} from "./fetch.ts";
export type { V2FetchParams } from "./fetch.ts";

export { v2Push, parseV2PushResponse, V2PushError, v1PushResultToV2 } from "./push.ts";
export type { V2PushCommand, V2PushRefUpdate, V2PushResult } from "./push.ts";

export { objectInfo, parseObjectInfoResponse, ObjectInfoError } from "./object-info.ts";
export type { ObjectInfoResult, ObjectInfoQueryResult } from "./object-info.ts";
