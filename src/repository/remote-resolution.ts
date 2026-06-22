/**
 * Remote 配置解析
 *
 * 集中处理 remote 配置的默认值决策：
 * - effectivePushUrl：options.pushUrl ?? remote.pushUrl ?? remote.url
 * - effectivePushRefSpecs：options.refSpecs ?? remote.pushRefSpecs
 * - effectiveShallowBoundaries：options.shallowBoundaries ?? backend.shallow.read() (非空时)
 *
 * 与 remote-operations.ts 分离，使 orchestration 只保留编排，不做内联决策。
 *
 * @example
 * ```ts
 * import { resolveEffectivePushUrl } from "./remote-resolution.ts";
 *
 * const pushUrl = resolveEffectivePushUrl(remote, { pushUrl: "..." });
 * ```
 */

import type { SHA1 } from "../core/types.ts";
import type { PushOptions } from "../transport/types.ts";
import type { RemoteConfig, PushRemoteOptions } from "./remote-types.ts";

/**
 * 解析 effective push URL
 *
 * 优先级：options.pushUrl > remote.pushUrl > remote.url
 *
 * @param remote - remote 配置
 * @param options - push remote 选项（可选）
 * @returns effective push URL
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
 *
 * @param remote - remote 配置
 * @param options - push 选项（可选）
 * @returns effective refSpecs 列表，可能为 undefined
 */
export function resolveEffectivePushRefSpecs(
  remote: RemoteConfig,
  options?: Pick<PushOptions, "refSpecs">,
): string[] | undefined {
  return options?.refSpecs ?? remote.pushRefSpecs;
}

/**
 * 解析 effective shallow boundaries
 *
 * 优先级：options.shallowBoundaries > backend.shallow.read()（非空时）
 * 返回 mutable 数组以兼容 transport PushOptions。
 *
 * @param options - push 选项（可选）
 * @param currentShallow - 当前 shallow 集合（SHA1[] 类型）
 * @returns effective shallow boundaries，可能为 undefined
 */
export function resolveEffectiveShallowBoundaries(
  options: { shallowBoundaries?: SHA1[] } | undefined,
  currentShallow: SHA1[],
): SHA1[] | undefined {
  if (options?.shallowBoundaries !== undefined) {
    return options.shallowBoundaries;
  }
  return currentShallow.length > 0 ? currentShallow : undefined;
}
