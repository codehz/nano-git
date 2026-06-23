/**
 * 传输层类型入口
 *
 * 纯类型导出。
 */

export type {
  RemoteRef,
  RefMappingRule,
  RefUpdateRejection,
  ApplyRefUpdatesResult,
} from "../transport/shared/types.ts";
export type {
  PktLine,
  PktLineData,
  PktLineFlush,
  PktLineDelimiter,
  PktLineResponseEnd,
} from "../transport/shared/pkt-line.ts";
export type { ParsedRefSpec } from "../transport/shared/refspec.ts";
export type { CollectReachableMissing } from "../transport/shared/object-graph.ts";
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
} from "../transport/v1/types.ts";
export type {
  V2CapabilityAdvertisement,
  V2CommandEntry,
  V2GitServiceTransport,
  V2FetchResponse,
  V2FetchRequest,
} from "../transport/v2/types.ts";
export type { SmartHttpAuth } from "../transport/v1/smart-http.ts";
export type { ReceivePackCommand } from "../transport/v1/receive-pack-request.ts";
export type { ProtocolDetectResult } from "../transport/v2/detect.ts";
export type { PushRefItem } from "../transport/v1/push-ref-plan.ts";
