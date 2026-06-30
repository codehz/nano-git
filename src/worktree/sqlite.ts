/**
 * SQLite Virtual Worktree 入口
 *
 * 对应 `nano-git/worktree/sqlite` 子路径。
 * 当前实现适用于单进程、单写者场景，不承诺跨进程并发写安全。
 */

export {
  deleteSqliteVirtualWorktree,
  type OpenSqliteVirtualWorktreeOptions,
  openSqliteVirtualWorktree,
  type SqliteVirtualWorktree,
} from "./sqlite-backend.ts";
