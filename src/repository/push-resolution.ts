/**
 * 仓库 push 参数解析
 *
 * 当前只负责 shallow 边界的最终决策。
 */

import type { SHA1 } from "../core/types.ts";
import type { RepositoryPushOptions } from "./push-types.ts";

/**
 * 解析 effective push shallow 边界
 *
 * 三态规则（`pushShallowBoundaries` 为 override，勿将 `[]` 当 falsy）：
 * - `options.pushShallowBoundaries === undefined`：回退 `backendShallow`（即 `backend.shallow.read()`）
 * - `options.pushShallowBoundaries === []`：显式无边界，不使用 `backend.shallow`
 * - `options.pushShallowBoundaries === [...]`：显式边界集合
 *
 * 输出为最终传给 transport 的 `shallowBoundaries` 数组；仅当 options 与 backend 均未提供时为 `undefined`。
 */
export function resolveEffectivePushBoundaries(
  options?: Pick<RepositoryPushOptions, "pushShallowBoundaries">,
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
