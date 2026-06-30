/**
 * 内存 Virtual Worktree 入口
 *
 * 对应 `nano-git/worktree/memory` 子路径。
 * 该入口不提供跨进程持久化与恢复能力。
 */

export { createVirtualWorktree, openVirtualWorktree } from "./worktree.ts";
