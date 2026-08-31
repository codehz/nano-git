/**
 * SQLite Virtual Worktree 入口
 *
 * 对应 `nano-git/worktree/sqlite` 子路径。
 * 在已打开的 SQLite 连接中管理多个按 key 区分的 VirtualWorktree；
 * 适用于单进程、单写者场景，不承诺跨进程并发写安全。
 *
 * @example
 * ```ts
 * import { Database } from "bun:sqlite";
 * import { createMemoryRepository } from "nano-git/repository/memory";
 * import { openSqliteVirtualWorktreeDatabase } from "nano-git/worktree/sqlite";
 * import type { SqliteDatabase } from "nano-git/types/sqlite";
 *
 * const repo = createMemoryRepository();
 * const tree = repo.createTree([]);
 * const sqlite = new Database("/tmp/wt.sqlite") as unknown as SqliteDatabase;
 * const db = openSqliteVirtualWorktreeDatabase(sqlite);
 * db.createWorktree("main", { baseTree: tree });
 * const wt = db.openWorktree(repo.objects, "main");
 * ```
 */

export {
  openSqliteVirtualWorktreeDatabase,
  type SqliteVirtualWorktreeDatabase,
  type SqliteVirtualWorktreeEntrySummary,
} from "./store/sqlite-backend.ts";

export type { SqliteDatabase, SqliteStatement, SqliteValue } from "../types/sqlite.ts";
