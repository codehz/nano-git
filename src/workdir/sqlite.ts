/**
 * SQLite Virtual Workdir 入口
 *
 * 对应 `nano-git/workdir/sqlite` 子路径。
 * 当前实现适用于单进程、单写者场景，不承诺跨进程并发写安全。
 */

export {
  deleteSqliteVirtualWorkdir,
  type OpenSqliteVirtualWorkdirOptions,
  openSqliteVirtualWorkdir,
  type SqliteVirtualWorkdir,
} from "./sqlite-backend.ts";
