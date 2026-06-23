/**
 * v1 传输模块
 *
 * 重新导出所有 Git Smart HTTP 协议 v1 的传输基础设施。
 */
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

export { advertiseRemote } from "./advertise.ts";
export { parseRefAdvertisement, RefAdvertisementError } from "./ref-advertisement.ts";
export {
  extractPackfile,
  extractProgress,
  extractRawPackfile,
  SideBandError,
} from "../shared/side-band.ts";
export { buildUploadPackRequest } from "./negotiate.ts";
export type { UploadPackNegotiationResponse } from "./negotiate.ts";
export { planRefUpdates, validateExactRules, RefPlanError } from "./fetch-ref-plan.ts";
export { fetchPack, FetchPackError } from "./fetch-pack.ts";
export { decodeUploadPackResponse, UploadPackResponseError } from "./upload-pack-response.ts";
export {
  applyRefUpdates,
  resolveBranchTargetHash,
  isRefNamespaceRequiringFastForward,
  RefUpdateError,
} from "../shared/update-refs.ts";

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
export { buildPushRequestBody } from "./push-request-plan.ts";

export {
  createUploadPackHttpClient,
  createReceivePackHttpClient,
  SmartHttpError,
} from "./smart-http.ts";
export type { SmartHttpAuth } from "./smart-http.ts";
export {
  extractCapabilities,
  PUSH_CAPABILITIES,
  FETCH_CAPABILITIES,
} from "./transport-capabilities.ts";
