/**
 * 内存 Virtual Workdir 入口
 *
 * 对应 `nano-git/workdir/memory` 子路径。
 * 该入口不提供跨进程持久化与恢复能力。
 */

export { createMemoryVirtualWorkdirBackend } from "./memory-backend.ts";
export { createVirtualWorkdirSession, openVirtualWorkdirSession } from "./session.ts";
