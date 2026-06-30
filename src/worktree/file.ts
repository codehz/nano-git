/**
 * 文件系统 Virtual Worktree 入口
 *
 * 对应 `nano-git/worktree/file` 子路径。
 * 每个 worktree 对应一个目录，以 `manifest.json` 作为主视图；
 * 适用于单进程、单写者场景，不承诺跨进程并发写安全。
 *
 * @example
 * ```ts
 * import { createMemoryRepository } from "nano-git/repository/memory";
 * import { openFileVirtualWorktree } from "nano-git/worktree/file";
 *
 * const repo = createMemoryRepository();
 * const tree = repo.createTree([]);
 * const worktree = openFileVirtualWorktree(repo.objects, "/tmp/wt-demo", {
 *   baseTree: tree,
 *   create: true,
 * });
 * ```
 */

export {
  deleteFileVirtualWorktree,
  openFileVirtualWorktree,
  createFileVirtualWorktreeStateStore,
  type OpenFileVirtualWorktreeOptions,
} from "./store/file-backend.ts";
