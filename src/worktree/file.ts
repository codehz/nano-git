/**
 * 文件系统 Virtual Worktree 入口
 *
 * 对应 `nano-git/worktree/file` 子路径。
 *
 * 当前实现以 `manifest.json` 作为主视图，
 * 适用于单进程、单写者场景，不承诺跨进程并发写安全。
 */

export {
  deleteFileVirtualWorktree,
  openFileVirtualWorktree,
  createFileVirtualWorktreeStateStore,
  type OpenFileVirtualWorktreeOptions,
} from "./file-backend.ts";
