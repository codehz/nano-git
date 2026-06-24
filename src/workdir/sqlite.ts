/**
 * SQLite Virtual Workdir 入口
 *
 * 对应 `nano-git/workdir/sqlite` 子路径。
 *
 * 返回的 backend 持有数据库连接；
 * 调用方在不再使用时应通过 `[Symbol.dispose]()` 显式释放资源。
 * 当前 backend 适用于单进程、单写者场景，不承诺跨进程并发写安全。
 */

export {
  createSqliteVirtualWorkdirBackend,
  type CreateSqliteVirtualWorkdirBackendOptions,
  type SqliteVirtualWorkdirBackend,
} from "./sqlite-backend.ts";
