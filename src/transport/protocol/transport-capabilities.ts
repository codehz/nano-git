/**
 * 传输层能力管理
 *
 * 处理 Git 协议中服务端能力声明与客户端可用能力的过滤。
 * 将 push/fetch 各自的能力白名单与共享的过滤逻辑合并。
 *
 * @example
 * ```ts
 * import { extractCapabilities, PUSH_CAPABILITIES } from "./transport-capabilities.ts";
 * const caps = extractCapabilities(serverCaps, PUSH_CAPABILITIES);
 * ```
 */

// ============================================================================
// 能力白名单
// ============================================================================

/** push (receive-pack) 默认支持的客户端能力 */
export const PUSH_CAPABILITIES = [
  "report-status",
  "side-band-64k",
  "ofs-delta",
  "no-progress",
  "delete-refs",
] as const;

// ============================================================================
// 能力过滤
// ============================================================================

/**
 * 从服务端 capabilities 中提取客户端可用的能力列表
 *
 * 将服务端声明的能力与客户端支持白名单取交集，
 * 只返回双方都支持的能力。
 *
 * @param serverCaps - 服务端声明的能力字典
 * @param supported - 客户端支持的能力白名单
 * @returns 双方都支持的能力名称列表
 *
 * @example
 * ```ts
 * const caps = extractCapabilities(
 *   { "report-status": true, "side-band-64k": true, "unknown-opt": "v1" },
 *   PUSH_CAPABILITIES,
 * );
 * // => ["report-status", "side-band-64k"]
 * ```
 */
export function extractCapabilities(
  serverCaps: Record<string, string | true>,
  supported: readonly string[],
): string[] {
  const supportedSet = new Set<string>(supported);
  return Object.keys(serverCaps).filter((cap) => supportedSet.has(cap));
}
