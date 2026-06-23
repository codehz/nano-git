/**
 * Git Wire 协议 — 共享工具层
 *
 * 仅导出协议无关的共享模块（shared/）。
 * client/ 和 server/ 的模块可通过各自的子路径按需导入：
 * - nano-git/transport/client/fetch
 * - nano-git/transport/client/push
 * - nano-git/transport/client/ls-refs
 * - nano-git/transport/server/upload-pack
 * - nano-git/transport/server/receive-pack
 * - nano-git/transport/server/smart-http
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
