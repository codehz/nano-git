/**
 * 测试用 SQLite 打开辅助
 *
 * 使用 `bun:sqlite`，并按本库声明的 `SqliteDatabase` 接口注入。
 */

import { Database } from "bun:sqlite";

import type { SqliteDatabase } from "@/types/sqlite.ts";

/** 打开测试用 SQLite（默认内存库），附带 Symbol.dispose 以便 using */
export function openTestSqlite(path = ":memory:"): SqliteDatabase & Disposable {
  const db = new Database(path);
  return Object.assign(db as unknown as SqliteDatabase, {
    [Symbol.dispose](): void {
      db.close();
    },
  });
}
