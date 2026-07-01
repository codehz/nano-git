/**
 * Git Wire 协议 — 共享工具层
 *
 * 仅导出协议原语层（protocol/）。
 * 客户端与 HTTP 适配层可通过聚合子路径按需导入：
 * - nano-git/transport/upload-pack
 * - nano-git/transport/receive-pack
 * - nano-git/transport/server/upload-pack
 * - nano-git/transport/server/receive-pack
 * - nano-git/transport/http
 * - 等
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
} from "./protocol/types.ts";

// pkt-line 编解码
export {
  encodePktLine,
  encodeFlushPkt,
  encodeDelimiterPkt,
  encodeResponseEndPkt,
  parsePktLines,
  splitPktLinesFromBuffer,
  PktLineError,
} from "./protocol/pkt-line.ts";
export type {
  PktLine,
  PktLineData,
  PktLineFlush,
  PktLineDelimiter,
  PktLineResponseEnd,
} from "./protocol/pkt-line.ts";

// RefSpec 解析与转换
export {
  parseRefSpec,
  mappingRuleToParsedSpec,
  parsedSpecToMappingRule,
  RefSpecError,
} from "./protocol/refspec.ts";
export type { ParsedRefSpec } from "./protocol/refspec.ts";

// Ref 收集与匹配
export { getLocalRefs, remoteRefsToMap } from "./protocol/ref-collection.ts";
export { matchesRefSpec, mapRefName } from "./protocol/ref-match.ts";

// 对象图算法
export { collectReachable, peelTagChain, isAncestor } from "./protocol/object-graph.ts";
export type {
  CollectReachableMissing,
  CollectReachableBitmapAssist,
} from "./protocol/object-graph.ts";

// side-band 解复用
export {
  extractPackfile,
  extractProgress,
  extractRawPackfile,
  SideBandError,
} from "./protocol/side-band.ts";

// Ref 更新
export {
  applyRefUpdates,
  resolveBranchTargetHash,
  isRefNamespaceRequiringFastForward,
  RefUpdateError,
} from "./protocol/update-refs.ts";
