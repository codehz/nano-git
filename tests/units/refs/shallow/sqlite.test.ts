/**
 * SQLite Shallow 存储单元测试
 *
 * 覆盖 ShallowStore 接口的全部场景。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import { acquireConnection } from "@/backend/sqlite-pool.ts";
import { sha1 } from "@/core/types.ts";
import { createSqliteShallowStore } from "@/refs/shallow/sqlite.ts";

import type { SHA1 } from "@/core/types.ts";

function makeHash(seed: string): SHA1 {
  return sha1(seed.padStart(40, "0").slice(0, 40));
}

const HASH_A = makeHash("a");
const HASH_B = makeHash("b");
const HASH_C = makeHash("c");

describe("createSqliteShallowStore()", () => {
  let conn: ReturnType<typeof acquireConnection>;
  let store: ReturnType<typeof createSqliteShallowStore>;

  beforeEach(() => {
    conn = acquireConnection(":memory:");
    conn.db.run("CREATE TABLE IF NOT EXISTS shallow (hash TEXT PRIMARY KEY)");
    store = createSqliteShallowStore(conn);
  });

  afterEach(() => {
    conn.release();
  });

  test("默认状态下 read 返回空数组", () => {
    expect(store.read()).toEqual([]);
  });

  test("write 后 read 返回写入的边界", () => {
    store.write([HASH_A, HASH_B]);
    expect(store.read()).toEqual([HASH_A, HASH_B]);
  });

  test("write 空数组清空 shallow 状态", () => {
    store.write([HASH_A]);
    store.write([]);
    expect(store.read()).toEqual([]);
  });

  test("read 返回排序后的结果", () => {
    store.write([HASH_B, HASH_A]);
    expect(store.read()).toEqual([HASH_A, HASH_B]);
  });

  test("applyUpdate 新增边界", () => {
    store.applyUpdate({ shallow: [HASH_A, HASH_B], unshallow: [] });
    expect(store.read()).toEqual([HASH_A, HASH_B]);
  });

  test("applyUpdate 删除边界", () => {
    store.write([HASH_A, HASH_B, HASH_C]);
    store.applyUpdate({ shallow: [], unshallow: [HASH_A] });
    expect(store.read()).toEqual([HASH_B, HASH_C]);
  });

  test("applyUpdate 同时新增和删除", () => {
    store.write([HASH_A, HASH_B]);
    store.applyUpdate({ shallow: [HASH_C], unshallow: [HASH_A] });
    expect(store.read()).toEqual([HASH_B, HASH_C]);
  });

  test("isShallow 返回正确结果", () => {
    store.write([HASH_A, HASH_B]);

    expect(store.isShallow(HASH_A)).toBe(true);
    expect(store.isShallow(HASH_B)).toBe(true);
    expect(store.isShallow(HASH_C)).toBe(false);
  });

  test("applyUpdate 原子性：中途出错时全部回滚", () => {
    // 先写入初始状态
    store.write([HASH_A]);

    // readonly DB 会使写入操作失败
    conn.db.run("PRAGMA query_only = 1");

    expect(() => {
      store.applyUpdate({ shallow: [HASH_B], unshallow: [HASH_A] });
    }).toThrow();

    // 恢复 readonly
    conn.db.run("PRAGMA query_only = 0");

    // 确认数据未变更
    expect(store.read()).toEqual([HASH_A]);
  });

  test("write 原子性：中途出错时全部回滚", () => {
    store.write([HASH_A]);

    conn.db.run("PRAGMA query_only = 1");

    expect(() => {
      store.write([HASH_B]);
    }).toThrow();

    conn.db.run("PRAGMA query_only = 0");

    // write 是 DELETE ALL + INSERT，事务回滚应保持原状
    expect(store.read()).toEqual([HASH_A]);
  });
});
