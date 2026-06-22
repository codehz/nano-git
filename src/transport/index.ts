/**
 * Smart HTTP 传输层
 *
 * 提供 Git Smart HTTP 协议的客户端实现，包含：
 * - pkt-line 帧编解码
 * - 引用广告解析
 * - side-band 多路解复用
 * - 请求生成与 HTTP 传输
 * - 新的分层 fetch 模块（advertise / fetch-ref-plan / fetch-pack / update-refs）
 */

// P1: 核心类型
export type {
  RemoteRef,
  RefAdvertisement,
  PushOptions,
  PushResult,
  PushRefUpdate,
  AdvertiseOptions,
  RemoteAdvertisement,
  RefMappingRule,
  RefUpdatePlanItem,
  RefUpdatePlan,
  FetchPackOptions,
  FetchPackResult,
  RefUpdateRejection,
  ApplyRefUpdatesResult,
} from "./types.ts";

// P1: pkt-line 编解码
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

// P2: ref 广告解析 & side-band 解复用
export { parseRefAdvertisement, RefAdvertisementError } from "./ref-advertisement.ts";
export {
  extractPackfile,
  extractProgress,
  extractRawPackfile,
  SideBandError,
} from "./side-band.ts";

// P3: 请求生成
export { buildUploadPackRequest } from "./negotiate.ts";
export { buildReceivePackRequest } from "./receive-pack-request.ts";
export type { ReceivePackCommand } from "./receive-pack-request.ts";

// P3b: 响应解析
export { parseReceivePackResult, ReceivePackResultError } from "./receive-pack-result.ts";

// P4: 广告获取
export { advertiseRemote } from "./advertise.ts";

// P5: RefSpec 解析
export {
  parseRefSpec,
  mappingRuleToParsedSpec,
  parsedSpecToMappingRule,
  RefSpecError,
} from "./refspec.ts";
export type { ParsedRefSpec } from "./refspec.ts";

// P5a: Ref 收集
export { getLocalRefs, remoteRefsToMap } from "./ref-collection.ts";

// P5b: Ref 匹配
export { matchesRefSpec, mapRefName } from "./ref-match.ts";

// P5c: Fetch Ref 规划
export { planRefUpdates, validateExactRules, RefPlanError } from "./fetch-ref-plan.ts";

// P6: Fetch-pack（对象同步，不写 ref）
export { fetchPack, FetchPackError } from "./fetch-pack.ts";

// P7: Ref 更新
export {
  applyRefUpdates,
  resolveBranchTargetHash,
  isRefNamespaceRequiringFastForward,
  RefUpdateError,
} from "./update-refs.ts";

// P8: HTTP 传输 & push 编排
export { createSmartHttpClient, SmartHttpError } from "./smart-http.ts";
export type { SmartHttpClient, UploadPackResult, ReceivePackHttpResult } from "./smart-http.ts";
export {
  extractCapabilities,
  PUSH_CAPABILITIES,
  FETCH_CAPABILITIES,
} from "./transport-capabilities.ts";
export { push, PushError } from "./push.ts";
export { checkFastForward } from "./push-policy.ts";
export { determinePushRefs, resolveDefaultRefSpec } from "./push-ref-plan.ts";
export type { PushRefItem } from "./push-ref-plan.ts";
export { mergePushBoundaries, computeObjectsToSend } from "./push-pack-plan.ts";
export { processPushReport } from "./push-report.ts";
