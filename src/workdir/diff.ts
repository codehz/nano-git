/**
 * Virtual Workdir diff 导出
 */

import { exportVirtualDiffFromChangeRecords } from "./change-index.ts";

import type { VirtualDiffEntry } from "./core.ts";
import type { VirtualWorkdirStateStore } from "./state-store.ts";

/**
 * 从规范化变更索引导出当前 session 的最终 diff。
 *
 * @example
 * ```ts
 * const diff = computeVirtualDiff(state);
 * expect(diff.map((entry) => entry.path)).toEqual(["hello.txt"]);
 * ```
 */
export function computeVirtualDiff(state: VirtualWorkdirStateStore): VirtualDiffEntry[] {
  return exportVirtualDiffFromChangeRecords(state.listChangeRecords());
}
