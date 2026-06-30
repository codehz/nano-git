/**
 * 内存 Virtual Worktree 入口
 *
 * 对应 `nano-git/worktree/memory` 子路径。
 * 状态保存在进程内，不提供跨进程持久化与恢复能力。
 *
 * @example
 * ```ts
 * import { createMemoryRepository } from "nano-git/repository/memory";
 * import { createVirtualWorktree } from "nano-git/worktree/memory";
 *
 * const repo = createMemoryRepository();
 * const tree = repo.createTree([]);
 * const worktree = createVirtualWorktree(repo.objects, { baseTree: tree });
 * ```
 */

export { createVirtualWorktree } from "./engine/worktree.ts";
