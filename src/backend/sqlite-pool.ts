/**
 * SQLite 连接池（引用计数）
 *
 * 缓存 Database 实例，相同 dbPath 复用同一连接，
 * 防止反复打开同一数据库文件带来的开销。
 *
 * 每个 acquire 对应一个 release，当引用计数归零时自动关闭连接。
 * 返回的 handle 实现了 [Symbol.dispose]()，可用 `using` 语法自动释放。
 *
 * @example
 * ```ts
 * using _conn = acquireConnection("/tmp/repo.sqlite");
 * // 作用域结束时自动释放
 * ```
 */

import { Database } from "bun:sqlite";

/** 连接池条目 */
interface PoolEntry {
  db: Database;
  refCount: number;
}

const pool = new Map<string, PoolEntry>();

/** 连接池获取结果 */
export interface SqliteConnectionHandle {
  readonly db: Database;
  /** 释放连接（引用计数减一，归零时关闭数据库） */
  readonly release: () => void;
  /** 支持 `using` 语法自动释放 */
  [Symbol.dispose](): void;
}

/** 构造连接句柄（release + Symbol.dispose） */
function makeHandle(db: Database, onRelease: () => void): SqliteConnectionHandle {
  return {
    db,
    release: onRelease,
    [Symbol.dispose](): void {
      onRelease();
    },
  };
}

/**
 * 从全局连接池获取或创建 SQLite 数据库连接
 *
 * 相同 dbPath 返回同一个 Database 实例，通过引用计数管理生命周期。
 * 首次打开时根据 walMode 执行 PRAGMA journal_mode = WAL。
 * 后续打开（缓存命中）忽略 walMode 参数。
 *
 * 注意：`:memory:` 和 `file:xxx?mode=memory` 等内存数据库不会被缓存，
 * 每次调用都会创建独立连接（SQLite 的 :memory: 为每个连接独立）。
 */
export function acquireConnection(dbPath: string, walMode = true): SqliteConnectionHandle {
  // 内存数据库不缓存——每个 :memory: 连接独立
  if (dbPath === ":memory:" || (dbPath.startsWith("file:") && dbPath.includes("mode=memory"))) {
    const db = new Database(dbPath);
    if (walMode) {
      db.run("PRAGMA journal_mode = WAL");
    }
    let released = false;
    return makeHandle(db, () => {
      if (released) return;
      released = true;
      db.close();
    });
  }

  const existing = pool.get(dbPath);
  if (existing !== undefined) {
    existing.refCount++;
    let released = false;
    return makeHandle(existing.db, () => {
      if (released) return;
      released = true;
      releaseConnection(dbPath);
    });
  }

  const db = new Database(dbPath);
  if (walMode) {
    db.run("PRAGMA journal_mode = WAL");
  }
  pool.set(dbPath, { db, refCount: 1 });

  let released = false;
  return makeHandle(db, () => {
    if (released) return;
    released = true;
    releaseConnection(dbPath);
  });
}

/** 内部释放逻辑 */
function releaseConnection(dbPath: string): void {
  const entry = pool.get(dbPath);
  if (entry === undefined) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    pool.delete(dbPath);
    entry.db.close();
  }
}

/**
 * 查询指定路径的连接活跃数（用于测试和调试）
 */
export function getActiveConnectionCount(dbPath: string): number {
  return pool.get(dbPath)?.refCount ?? 0;
}

/**
 * 关闭池中所有连接并清空池（用于测试清理）
 */
export function resetPool(): void {
  for (const [, entry] of pool) {
    entry.db.close();
  }
  pool.clear();
}
