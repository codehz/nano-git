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
} from "../transport/types.ts";
export type {
  PktLine,
  PktLineData,
  PktLineFlush,
  PktLineDelimiter,
  PktLineResponseEnd,
} from "../transport/pkt-line.ts";
export type { ParsedRefSpec } from "../transport/refspec.ts";
export type { CollectReachableMissing } from "../transport/object-graph.ts";
export type {
  GitServiceTransport,
  UploadPackTransport,
  ReceivePackTransport,
  RefAdvertisement,
  PushOptions,
  PushResult,
  PushRefUpdate,
} from "../transport/types.ts";
export type {
  V2CapabilityAdvertisement,
  V2CommandEntry,
  V2GitServiceTransport,
  V2FetchResponse,
  V2FetchRequest,
} from "../transport/protocol-types.ts";
export type { SmartHttpAuth } from "../transport/smart-http.ts";
export type { ReceivePackCommand } from "../transport/receive-pack-request.ts";
export type { PushRefItem } from "../transport/push-ref-plan.ts";
