/**
 * Smart HTTP 传输层
 *
 * 统一入口，按职责分组导出：
 * - 共享模块：pkt-line、refspec、对象图等
 * - Push 客户端：v1 receive-pack 协议
 * - Push 服务端：receive-pack 接口
 * - Fetch 客户端（v2 协议）：ls-refs、fetch、object-info
 * - Fetch 服务端（v2 协议）：serve、capability-advert
 */

// ============================================================================
// 共享模块（协议无关）
// ============================================================================

// 核心类型（共享）
export type {
  RemoteRef,
  RefMappingRule,
  RefUpdateRejection,
  ApplyRefUpdatesResult,
} from "./types.ts";

// pkt-line 编解码
export {
  encodePktLine,
  encodeFlushPkt,
  encodeDelimiterPkt,
  encodeResponseEndPkt,
  parsePktLines,
  splitPktLinesFromBuffer,
  PktLineError,
} from "./pkt-line.ts";
export type {
  PktLine,
  PktLineData,
  PktLineFlush,
  PktLineDelimiter,
  PktLineResponseEnd,
} from "./pkt-line.ts";

// RefSpec 解析与转换
export {
  parseRefSpec,
  mappingRuleToParsedSpec,
  parsedSpecToMappingRule,
  RefSpecError,
} from "./refspec.ts";
export type { ParsedRefSpec } from "./refspec.ts";

// Ref 收集与匹配
export { getLocalRefs, remoteRefsToMap } from "./ref-collection.ts";
export { matchesRefSpec, mapRefName } from "./ref-match.ts";

// 对象图算法
export { collectReachable, peelTagChain, isAncestor } from "./object-graph.ts";
export type { CollectReachableMissing } from "./object-graph.ts";

// side-band 解复用
export {
  extractPackfile,
  extractProgress,
  extractRawPackfile,
  SideBandError,
} from "./side-band.ts";

// Ref 更新
export {
  applyRefUpdates,
  resolveBranchTargetHash,
  isRefNamespaceRequiringFastForward,
  RefUpdateError,
} from "./update-refs.ts";

// ============================================================================
// Push 客户端（v1 协议）
// ============================================================================

export type {
  GitServiceTransport,
  UploadPackTransport,
  ReceivePackTransport,
  RefAdvertisement,
  PushOptions,
  PushResult,
  PushRefUpdate,
} from "./types.ts";

// 能力声明
export { extractCapabilities, PUSH_CAPABILITIES } from "./transport-capabilities.ts";

// ref 广告解析
export { parseRefAdvertisement, RefAdvertisementError } from "./ref-advertisement.ts";

// Push
export { push, PushError } from "./push.ts";
export { determinePushRefs, resolveDefaultRefSpec } from "./push-ref-plan.ts";
export type { PushRefItem } from "./push-ref-plan.ts";
export { checkFastForward } from "./push-policy.ts";
export { mergePushBoundaries, computeObjectsToSend } from "./push-pack-plan.ts";
export { processPushReport } from "./push-report.ts";
export { buildReceivePackRequest } from "./receive-pack-request.ts";
export type { ReceivePackCommand } from "./receive-pack-request.ts";
export { parseReceivePackResult, ReceivePackResultError } from "./receive-pack-result.ts";
export { decodeReceivePackResponse, ReceivePackResponseError } from "./receive-pack-response.ts";

// HTTP 传输
export { createReceivePackHttpClient, SmartHttpError } from "./smart-http.ts";
export type { SmartHttpAuth } from "./smart-http.ts";

// ============================================================================
// Push 服务端（receive-pack）
// ============================================================================

export {
  serveV1Advertise,
  handleV1ReceivePush,
  parseV1ReceivePackRequest,
  V1ReceivePackError,
} from "./receive-pack/index.ts";
export type {
  V1ReceivePackCommand,
  ParsedV1ReceivePackRequest,
  V1RefUpdateResult,
  V1ReceivePackOptions,
} from "./receive-pack/index.ts";

// ============================================================================
// Fetch 客户端（v2 协议）
// ============================================================================

export type {
  V2CapabilityAdvertisement,
  V2CommandEntry,
  V2GitServiceTransport,
  V2FetchResponse,
  V2FetchRequest,
} from "./protocol-types.ts";

export {
  v2Fetch,
  v2FetchObjects,
  parseV2FetchResponse,
  negotiateV2Fetch,
  V2FetchError,
} from "./fetch.ts";
export type { V2FetchParams } from "./fetch.ts";

export { lsRefs, parseLsRefsResponse, lsRefsToRefAdvertisement, LsRefsError } from "./ls-refs.ts";
export type { LsRefsOptions, LsRefsEntry } from "./ls-refs.ts";

export { objectInfo, ObjectInfoError } from "./object-info.ts";
export type { ObjectInfoResult, ObjectInfoQueryResult } from "./object-info.ts";

// v2 传输适配器
export { createV2HttpTransport, V2SmartHttpError } from "./git-transport.ts";

// ============================================================================
// Fetch 服务端（v2 协议）
// ============================================================================

export {
  parseV2CapabilityAdvertisement,
  hasCommand,
  getCommandFeatures,
  V2CapabilityError,
} from "./capability-advert.ts";

export {
  serveV2Advertise,
  parseV2Command,
  parseLsRefsArgs,
  generateLsRefsResponse,
  parseFetchArgs,
  generateFetchResponse,
} from "./serve.ts";
export type { ParsedV2Command, LsRefsServerOptions, FetchServerParams } from "./serve.ts";

// Upload-Pack 服务（server 端方案编排器）
export { createUploadPackService, UploadPackError } from "./server/upload-pack.ts";
export type { UploadPackService } from "./server/upload-pack.ts";

// HTTP 适配器
export { createSmartHttpHandler } from "./server/smart-http.ts";
export type { SmartHttpHandler } from "./server/types.ts";
