/**
 * Remote 配置解析
 *
 * 集中处理 remote 配置的默认值决策：
 * - effectivePushUrl：options.pushUrl ?? remote.pushUrl ?? remote.url
 * - effectivePushRefSpecs：options.refSpecs ?? remote.pushRefSpecs
 *
 * shallow 由 repository 内部从 backend.shallow 推导，不在公共 API 暴露。
 *
 * @example
 * ```ts
 * import { resolveEffectivePushUrl } from "./remote-resolution.ts";
 *
 * const pushUrl = resolveEffectivePushUrl(remote, { pushUrl: "..." });
 * ```
 */

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
