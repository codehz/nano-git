/**
 * SQLite Refs 存储特有行为测试
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { openTestSqlite } from "../../helpers/sqlite.ts";
import { createSqliteRefStore } from "@/refs/sqlite.ts";

import type { RefStore } from "@/types/refs.ts";
import type { SqliteDatabase } from "@/types/sqlite.ts";

describe("createSqliteRefStore()", () => {
  let db: SqliteDatabase & Disposable;
  let store: RefStore;

  beforeEach(() => {
    db = openTestSqlite();
    db.run("CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, target TEXT NOT NULL)");
    store = createSqliteRefStore(db);
  });

  afterEach(() => {
    db[Symbol.dispose]();
  });

  test("SQLite list() 使用字符串范围查询仍只返回指定前缀", () => {
    store.write("refs/heads/main", "111");
    store.write("refs/heads/feature/api", "222");
    store.write("refs/heads-archive/main", "333");
    store.write("refs/tags/v1", "444");

    expect(store.list("refs/heads/")).toEqual(["refs/heads/feature/api", "refs/heads/main"]);
  });
});
