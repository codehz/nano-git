/**
 * Git Wire 协议传输层
 *
 * 统一入口，按参与方和职责分组：
 * - shared/       : 协议无关的共享工具
 * - client/       : 客户端代码（push 除外的大多数协议使用 v2 作为默认协议）
 * - client/push/  : Push 客户端（v1 receive-pack 协议）
 * - server/       : 服务端代码（含 upload-pack 和 receive-pack）
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
} from "./shared/types.ts";

// pkt-line 编解码
export {
  encodePktLine,
  encodeFlushPkt,
  encodeDelimiterPkt,
  encodeResponseEndPkt,
  parsePktLines,
  splitPktLinesFromBuffer,
  PktLineError,
} from "./shared/pkt-line.ts";
export type {
  PktLine,
  PktLineData,
  PktLineFlush,
  PktLineDelimiter,
  PktLineResponseEnd,
} from "./shared/pkt-line.ts";

// RefSpec 解析与转换
export {
  parseRefSpec,
  mappingRuleToParsedSpec,
  parsedSpecToMappingRule,
  RefSpecError,
} from "./shared/refspec.ts";
export type { ParsedRefSpec } from "./shared/refspec.ts";

// Ref 收集与匹配
export { getLocalRefs, remoteRefsToMap } from "./shared/ref-collection.ts";
export { matchesRefSpec, mapRefName } from "./shared/ref-match.ts";

// 对象图算法
export { collectReachable, peelTagChain, isAncestor } from "./shared/object-graph.ts";
export type { CollectReachableMissing } from "./shared/object-graph.ts";

// side-band 解复用
export {
  extractPackfile,
  extractProgress,
  extractRawPackfile,
  SideBandError,
} from "./shared/side-band.ts";

// Ref 更新
export {
  applyRefUpdates,
  resolveBranchTargetHash,
  isRefNamespaceRequiringFastForward,
  RefUpdateError,
} from "./shared/update-refs.ts";

// ============================================================================
// Push 客户端（v1 receive-pack 协议）
// ============================================================================

export type {
  GitServiceTransport,
  UploadPackTransport,
  ReceivePackTransport,
  RefAdvertisement,
  PushOptions,
  PushResult,
  PushRefUpdate,
} from "./shared/types.ts";

// 能力声明
export { extractCapabilities, PUSH_CAPABILITIES } from "./shared/transport-capabilities.ts";

// ref 广告解析
export { parseRefAdvertisement, RefAdvertisementError } from "./shared/ref-advertisement.ts";

// Push 编排
export { push, PushError } from "./client/push/push.ts";
export { determinePushRefs, resolveDefaultRefSpec } from "./client/push/push-ref-plan.ts";
export type { PushRefItem } from "./client/push/push-ref-plan.ts";
export { checkFastForward } from "./client/push/push-policy.ts";
export { mergePushBoundaries, computeObjectsToSend } from "./client/push/push-pack-plan.ts";
export { processPushReport } from "./client/push/push-report.ts";
export { buildReceivePackRequest } from "./client/push/request.ts";
export type { ReceivePackCommand } from "./client/push/request.ts";
export { parseReceivePackResult, ReceivePackResultError } from "./client/push/result.ts";
export { decodeReceivePackResponse, ReceivePackResponseError } from "./client/push/response.ts";

// HTTP 传输
export { createReceivePackHttpClient, SmartHttpError } from "./client/push/http.ts";
export type { SmartHttpAuth } from "./client/push/http.ts";

// ============================================================================
// Push 服务端（v1 receive-pack）
// ============================================================================

export {
  serveV1Advertise,
  handleV1ReceivePush,
  parseV1ReceivePackRequest,
  V1ReceivePackError,
} from "./server/receive-pack/index.ts";
export type {
  V1ReceivePackCommand,
  ParsedV1ReceivePackRequest,
  V1RefUpdateResult,
  V1ReceivePackOptions,
} from "./server/receive-pack/index.ts";

// ============================================================================
// 客户端（v2 默认协议：fetch、ls-refs、object-info）
// ============================================================================

export type {
  V2CapabilityAdvertisement,
  V2CommandEntry,
  V2GitServiceTransport,
  V2FetchResponse,
  V2FetchRequest,
} from "./client/protocol-types.ts";

export {
  v2Fetch,
  v2FetchObjects,
  parseV2FetchResponse,
  negotiateV2Fetch,
  V2FetchError,
} from "./client/fetch.ts";
export type { V2FetchParams } from "./client/fetch.ts";

export {
  lsRefs,
  parseLsRefsResponse,
  lsRefsToRefAdvertisement,
  LsRefsError,
} from "./client/ls-refs.ts";
export type { LsRefsOptions, LsRefsEntry } from "./client/ls-refs.ts";

export { objectInfo, ObjectInfoError } from "./client/object-info.ts";
export type { ObjectInfoResult, ObjectInfoQueryResult } from "./client/object-info.ts";

// v2 传输适配器
export { createV2HttpTransport, V2SmartHttpError } from "./client/git-transport.ts";

// ============================================================================
// 服务端（v2 默认协议 + HTTP 适配）
// ============================================================================

export {
  parseV2CapabilityAdvertisement,
  hasCommand,
  getCommandFeatures,
  V2CapabilityError,
} from "./client/capability-advert.ts";

export {
  serveV2Advertise,
  parseV2Command,
  parseLsRefsArgs,
  generateLsRefsResponse,
  parseFetchArgs,
  generateFetchResponse,
} from "./server/upload-pack/serve.ts";
export type {
  ParsedV2Command,
  LsRefsServerOptions,
  FetchServerParams,
} from "./server/upload-pack/serve.ts";

// Upload-Pack 服务编排器
export { createUploadPackService, UploadPackError } from "./server/upload-pack.ts";
export type { UploadPackService } from "./server/upload-pack.ts";

// HTTP 适配器
export { createSmartHttpHandler } from "./server/smart-http.ts";
export type { SmartHttpHandler } from "./server/types.ts";
