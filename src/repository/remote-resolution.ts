/**
 * Remote 配置解析
 *
 * 集中处理 remote 配置的默认值决策：
 * - effectivePushUrl：options.pushUrl ?? remote.pushUrl ?? remote.url
 * - effectivePushRefSpecs：options.refSpecs ?? remote.pushRefSpecs
 * - effectivePushBoundaries：options.pushShallowBoundaries ?? backend.shallow
 *
 * push 的认证（token/headers）直接透传，不在此解析。
 *
 * @example
 * ```ts
 * import { resolveEffectivePushUrl } from "./remote-resolution.ts";
 *
 * const pushUrl = resolveEffectivePushUrl(remote, { pushUrl: "..." });
 * ```
 */

import type { SHA1 } from "../core/types.ts";
import type { RemoteConfig, PushRemoteOptions } from "./remote-types.ts";

/**
 * 解析 effective push URL
 *
 * 优先级：options.pushUrl > remote.pushUrl > remote.url
 */
export function resolveEffectivePushUrl(
  remote: RemoteConfig,
  options?: Pick<PushRemoteOptions, "pushUrl">,
): string {
  return options?.pushUrl ?? remote.pushUrl ?? remote.url;
}

/**
 * 解析 effective push refSpecs
 *
 * 优先级：options.refSpecs > remote.pushRefSpecs
 */
export function resolveEffectivePushRefSpecs(
  remote: RemoteConfig,
  options?: Pick<PushRemoteOptions, "refSpecs">,
): string[] | undefined {
  return options?.refSpecs ?? remote.pushRefSpecs;
}

/**
 * 解析 effective push shallow 边界
 *
 * 优先级：
 * 1. options.pushShallowBoundaries（显式传入）
 * 2. 回退 backend.shallow.read() 的当前值
 *
 * 输出为最终传给 transport 的 shallowBoundaries（undefined 表示无浅克隆边界）。
 *
 * 这样 push URL、refspec、认证、边界决策都集中在 resolution 模块。
 */
export function resolveEffectivePushBoundaries(
  options?: Pick<PushRemoteOptions, "pushShallowBoundaries">,
  backendShallow?: SHA1[],
): SHA1[] | undefined {
  if (options?.pushShallowBoundaries && options.pushShallowBoundaries.length > 0) {
    return options.pushShallowBoundaries;
  }
  if (backendShallow && backendShallow.length > 0) {
    return backendShallow;
  }
  return undefined;
}
