/**
 * Remote 配置解析
 *
 * 集中处理 remote 配置的默认值决策：
 * - effectivePushUrl：options.pushUrl ?? remote.pushUrl ?? remote.url
 * - effectivePushRefSpecs：options.refSpecs ?? remote.pushRefSpecs
 * - effectivePushBoundaries：options.pushShallowBoundaries 显式覆盖；未传则回退 backend.shallow
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
 * 三态规则（`pushShallowBoundaries` 为 override，勿将 `[]` 当 falsy）：
 * - `options.pushShallowBoundaries === undefined`：回退 `backendShallow`（即 `backend.shallow.read()`）
 * - `options.pushShallowBoundaries === []`：显式无边界，不使用 backend.shallow
 * - `options.pushShallowBoundaries === [...]`：显式边界集合
 *
 * 输出为最终传给 transport 的 `shallowBoundaries` 数组；仅当 options 与 backend 均未提供时为 `undefined`。
 */
export function resolveEffectivePushBoundaries(
  options?: Pick<PushRemoteOptions, "pushShallowBoundaries">,
  backendShallow?: SHA1[],
): SHA1[] | undefined {
  if (options?.pushShallowBoundaries !== undefined) {
    return options.pushShallowBoundaries;
  }
  if (backendShallow !== undefined) {
    return backendShallow;
  }
  return undefined;
}
