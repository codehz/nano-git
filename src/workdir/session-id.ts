/**
 * Virtual Workdir session ID 工具
 */

import type { VirtualWorkdirSessionId } from "./core.ts";

let nextSessionCounter = 1;

/**
 * 分配新的 session ID
 *
 * @example
 * ```ts
 * const sessionId = createVirtualWorkdirSessionId();
 * expect(String(sessionId).startsWith("session:")).toBe(true);
 * ```
 */
export function createVirtualWorkdirSessionId(): VirtualWorkdirSessionId {
  const id = `session:${nextSessionCounter}` as VirtualWorkdirSessionId;
  nextSessionCounter += 1;
  return id;
}

/**
 * 重置 session ID 计数器（仅测试使用）
 *
 * @example
 * ```ts
 * resetVirtualWorkdirSessionIdCounterForTests(1);
 * const sessionId = createVirtualWorkdirSessionId();
 * expect(sessionId).toBe("session:1");
 * ```
 */
export function resetVirtualWorkdirSessionIdCounterForTests(start = 1): void {
  nextSessionCounter = start;
}
