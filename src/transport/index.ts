/**
 * Smart HTTP 传输层
 *
 * 导出按模块分组：
 * - 基础模块：核心类型、pkt-line、refspec、ref 收集/匹配、对象图
 * - Fetch 模块：广告获取、fetch 规划、fetch-pack、ref 更新
 * - Push 模块：push 编排、策略、报告解析
 * - HTTP 传输：Smart HTTP 客户端、能力声明
 */

// ============================================================================
// 基础模块（协议无关）
// ============================================================================

// 核心类型
export type {
  GitServiceTransport,
  RemoteRef,
  RefAdvertisement,
  PushOptions,
  PushResult,
  PushRefUpdate,
  AdvertiseOptions,
  RefMappingRule,
  MatchedRefItem, // 完整匹配结果；注意 matchedItems ≠ refUpdates
  RefUpdatePlanItem,
  FetchPlan,
  FetchPackOptions,
  FetchPackResult,
  RefUpdateRejection,
  ApplyRefUpdatesResult,
  UploadPackTransport,
  ReceivePackTransport,
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

// 能力声明
export {
  extractCapabilities,
  PUSH_CAPABILITIES,
  FETCH_CAPABILITIES,
} from "./transport-capabilities.ts";

// ============================================================================
// Fetch 模块
// ============================================================================

// 广告获取
export { advertiseRemote } from "./advertise.ts";

// ref 广告解析 & side-band 解复用
export { parseRefAdvertisement, RefAdvertisementError } from "./ref-advertisement.ts";
export {
  extractPackfile,
  extractProgress,
  extractRawPackfile,
  SideBandError,
} from "./side-band.ts";

// fetch 规划（纯映射层）
export { planRefUpdates, validateExactRules, RefPlanError } from "./fetch-ref-plan.ts";

// fetch-pack（对象同步，不写 ref）
export { fetchPack, FetchPackError } from "./fetch-pack.ts";
export { decodeUploadPackResponse, UploadPackResponseError } from "./upload-pack-response.ts";

// 请求生成（negotiate）
export { buildUploadPackRequest } from "./negotiate.ts";

// Ref 更新
export {
  applyRefUpdates,
  resolveBranchTargetHash,
  isRefNamespaceRequiringFastForward,
  RefUpdateError,
} from "./update-refs.ts";

// ============================================================================
// Push 模块
// ============================================================================

// Push 编排
export { push, PushError } from "./push.ts";

// Push 引用规划
export { determinePushRefs, resolveDefaultRefSpec } from "./push-ref-plan.ts";
export type { PushRefItem } from "./push-ref-plan.ts";

// Push 策略
export { checkFastForward } from "./push-policy.ts";

// Push pack 规划
export { mergePushBoundaries, computeObjectsToSend } from "./push-pack-plan.ts";

// Push 报告解析
export { processPushReport } from "./push-report.ts";

// receive-pack 请求/响应
export { buildReceivePackRequest } from "./receive-pack-request.ts";
export type { ReceivePackCommand } from "./receive-pack-request.ts";
export { parseReceivePackResult, ReceivePackResultError } from "./receive-pack-result.ts";
export { decodeReceivePackResponse, ReceivePackResponseError } from "./receive-pack-response.ts";

// ============================================================================
// HTTP 传输
// ============================================================================

export {
  createUploadPackHttpClient,
  createReceivePackHttpClient,
  SmartHttpError,
} from "./smart-http.ts";
export type { SmartHttpAuth } from "./smart-http.ts";
