/**
 * Git Wire 协议 v2 模块
 *
 * 导出所有 v2 协议相关的类型、解析函数和检测工具。
 */

export type {
  V2CapabilityAdvertisement,
  V2CommandEntry,
  V2GitServiceTransport,
  LsRefsEntry,
  V2FetchRequest,
  V2FetchResponse,
  V2PushRequest,
  ObjectInfoEntry,
  ObjectInfoResponse,
} from "./types.ts";

export {
  parseV2CapabilityAdvertisement,
  hasCommand,
  getCommandFeatures,
  V2CapabilityError,
} from "./capability-advert.ts";

export { detectProtocol } from "./detect.ts";
export type { ProtocolDetectResult } from "./detect.ts";
