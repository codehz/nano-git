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
  PushOptions,
  PushResult,
  PushRefUpdate,
} from "../transport/shared/types.ts";
export type {
  V2CapabilityAdvertisement,
  V2CommandEntry,
  V2GitServiceTransport,
  V2FetchResponse,
  V2FetchRequest,
} from "../transport/client/protocol-types.ts";
export type { SmartHttpAuth } from "../transport/client/push/http.ts";
export type { ReceivePackCommand } from "../transport/client/push/request.ts";
export type { PushRefItem } from "../transport/client/push/push-ref-plan.ts";
