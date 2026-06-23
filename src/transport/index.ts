/**
 * Smart HTTP 传输层
 *
 * 统一入口，按模块分组导出：
 * - shared/: 协议无关的基础模块（pkt-line、refspec、对象图等）
 * - v1/: Git Smart HTTP 协议 v1 实现
 * - v2/: Git Wire 协议 v2 实现
 *
 * 提供自动协商函数 detectProtocol，优先尝试 v2 协议，不支持时回退到 v1。
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
// v1 模块
// ============================================================================

// 核心类型（v1 专用）
export type {
  GitServiceTransport,
  UploadPackTransport,
  ReceivePackTransport,
  RefAdvertisement,
  AdvertiseOptions,
  MatchedRefItem,
  RefUpdatePlanItem,
  FetchPlan,
  FetchPackOptions,
  FetchPackResult,
  PushOptions,
  PushResult,
  PushRefUpdate,
} from "./v1/types.ts";

// 能力声明（v1）
export {
  extractCapabilities,
  PUSH_CAPABILITIES,
  FETCH_CAPABILITIES,
} from "./v1/transport-capabilities.ts";

// 广告获取（v1）
export { advertiseRemote } from "./v1/advertise.ts";

// ref 广告解析（v1）
export { parseRefAdvertisement, RefAdvertisementError } from "./v1/ref-advertisement.ts";

// fetch 规划（v1）
export { planRefUpdates, validateExactRules, RefPlanError } from "./v1/fetch-ref-plan.ts";

// fetch-pack（v1）
export { fetchPack, FetchPackError } from "./v1/fetch-pack.ts";
export { decodeUploadPackResponse, UploadPackResponseError } from "./v1/upload-pack-response.ts";

// 请求生成（v1）
export { buildUploadPackRequest } from "./v1/negotiate.ts";

// Push（v1）
export { push, PushError } from "./v1/push.ts";
export { determinePushRefs, resolveDefaultRefSpec } from "./v1/push-ref-plan.ts";
export type { PushRefItem } from "./v1/push-ref-plan.ts";
export { checkFastForward } from "./v1/push-policy.ts";
export { mergePushBoundaries, computeObjectsToSend } from "./v1/push-pack-plan.ts";
export { processPushReport } from "./v1/push-report.ts";
export { buildReceivePackRequest } from "./v1/receive-pack-request.ts";
export type { ReceivePackCommand } from "./v1/receive-pack-request.ts";
export { parseReceivePackResult, ReceivePackResultError } from "./v1/receive-pack-result.ts";
export { decodeReceivePackResponse, ReceivePackResponseError } from "./v1/receive-pack-response.ts";

// HTTP 传输（v1）
export {
  createUploadPackHttpClient,
  createReceivePackHttpClient,
  SmartHttpError,
} from "./v1/smart-http.ts";
export type { SmartHttpAuth } from "./v1/smart-http.ts";

// ============================================================================
// v2 模块
// ============================================================================

export type {
  V2CapabilityAdvertisement,
  V2CommandEntry,
  V2GitServiceTransport,
  V2FetchResponse,
  V2FetchRequest,
} from "./v2/types.ts";

export {
  parseV2CapabilityAdvertisement,
  hasCommand,
  getCommandFeatures,
  V2CapabilityError,
} from "./v2/capability-advert.ts";

export { detectProtocol } from "./v2/detect.ts";
export type { ProtocolDetectResult } from "./v2/detect.ts";
