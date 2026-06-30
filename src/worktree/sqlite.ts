/**
 * SQLite Virtual Worktree 入口
 *
 * 对应 `nano-git/worktree/sqlite` 子路径。
 * 在单个 SQLite 文件中管理多个按 key 区分的 VirtualWorktree；
 * 适用于单进程、单写者场景，不承诺跨进程并发写安全。
 *
 * @example
 * ```ts
 * import { createMemoryRepository } from "nano-git/repository/memory";
 * import { openSqliteVirtualWorktreeDatabase } from "nano-git/worktree/sqlite";
 *
 * const repo = createMemoryRepository();
 * const tree = repo.createTree([]);
 * using db = openSqliteVirtualWorktreeDatabase("/tmp/wt.sqlite");
 * db.createWorktree("main", { baseTree: tree });
 * const wt = db.openWorktree(repo.objects, "main");
 * ```
 */

export {
  type OpenSqliteVirtualWorktreeDatabaseOptions,
  openSqliteVirtualWorktreeDatabase,
  type SqliteVirtualWorktreeDatabase,
  type SqliteVirtualWorktreeEntrySummary,
} from "./store/sqlite-backend.ts";
