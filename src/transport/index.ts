/**
 * Smart HTTP 传输层
 *
 * 统一入口，按模块分组导出：
 * - 共享模块：pkt-line、refspec、对象图等
 * - v1：Git Smart HTTP 协议 v1 实现
 * - v2：Git Wire 协议 v2 实现（部分功能）
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
} from "./types.ts";

// 能力声明（v1）
export {
  extractCapabilities,
  PUSH_CAPABILITIES,
  FETCH_CAPABILITIES,
} from "./transport-capabilities.ts";

// 广告获取（v1）
export { advertiseRemote } from "./advertise.ts";

// ref 广告解析（v1）
export { parseRefAdvertisement, RefAdvertisementError } from "./ref-advertisement.ts";

// fetch 规划（v1）
export { planRefUpdates, validateExactRules, RefPlanError } from "./fetch-ref-plan.ts";

// fetch-pack（v1）
export { fetchPack, FetchPackError } from "./fetch-pack.ts";
export { decodeUploadPackResponse, UploadPackResponseError } from "./upload-pack-response.ts";

// 请求生成（v1）
export { buildUploadPackRequest } from "./negotiate.ts";

// Push（v1）
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

// HTTP 传输（v1）
export {
  createUploadPackHttpClient,
  createReceivePackHttpClient,
  SmartHttpError,
} from "./smart-http.ts";
export type { SmartHttpAuth } from "./smart-http.ts";

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
