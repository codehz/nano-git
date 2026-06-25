/**
 * SQLite Refs 存储单元测试
 *
 * 覆盖 RefStore 和 RefTransaction 的 SQLite 实现的全部场景。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import { acquireConnection } from "@/backend/sqlite-pool.ts";
import { RefNotFoundError, TransactionError } from "@/core/errors.ts";
import { createSqliteRefStore } from "@/refs/sqlite.ts";

import type { SqliteConnectionHandle } from "@/backend/sqlite-pool.ts";
import type { RefStore, RefTransactionHook } from "@/core/types/refs.ts";

// ============================================================================
// CRUD 操作
// ============================================================================

describe("createSqliteRefStore()", () => {
  let conn: SqliteConnectionHandle;
  let store: RefStore;

  beforeEach(() => {
    conn = acquireConnection(":memory:");
    conn.db.run("CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, target TEXT NOT NULL)");
    store = createSqliteRefStore(conn);
  });

  afterEach(() => {
    conn.release();
  });

  test("read() 不存在的引用返回 null", () => {
    expect(store.read("refs/heads/main")).toBeNull();
  });

  test("write() + read() 基本写入读取", () => {
    store.write("refs/heads/main", "abc123");
    expect(store.read("refs/heads/main")).toBe("abc123");
  });

  test("write() 规范化末尾换行", () => {
    store.write("refs/heads/main", "abc123\n");
    expect(store.read("refs/heads/main")).toBe("abc123");
  });

  test("write() 规范化末尾多个换行", () => {
    store.write("refs/heads/main", "abc123\n\n\n");
    expect(store.read("refs/heads/main")).toBe("abc123");
  });

  test("write() 不移除前导空白", () => {
    store.write("refs/heads/main", " abc123");
    expect(store.read("refs/heads/main")).toBe(" abc123");
  });

  test("write() 覆盖已有引用", () => {
    store.write("refs/heads/main", "old");
    store.write("refs/heads/main", "new");
    expect(store.read("refs/heads/main")).toBe("new");
  });

  test("delete() 删除已有引用", () => {
    store.write("refs/heads/main", "abc123");
    store.delete("refs/heads/main");
    expect(store.read("refs/heads/main")).toBeNull();
  });

  test("delete() 对不存在的引用抛出 RefNotFoundError", () => {
    expect(() => store.delete("refs/heads/missing")).toThrow(RefNotFoundError);
  });

  test("list() 返回指定前缀下的引用，按名称排序", () => {
    store.write("refs/heads/z-final", "333");
    store.write("refs/heads/feature/api", "111");
    store.write("refs/heads/main", "222");

    expect(store.list("refs/heads/")).toEqual([
      "refs/heads/feature/api",
      "refs/heads/main",
      "refs/heads/z-final",
    ]);
  });

  test("list() 不返回其他前缀的引用", () => {
    store.write("refs/heads/main", "abc");
    store.write("refs/tags/v1", "def");

    expect(store.list("refs/heads/")).toEqual(["refs/heads/main"]);
    expect(store.list("refs/tags/")).toEqual(["refs/tags/v1"]);
  });

  test("list() 校验前缀格式", () => {
    expect(() => store.list("refs/heads")).toThrow("Invalid ref prefix");
    expect(() => store.list("invalid")).toThrow("Invalid ref prefix");
  });

  test("listAll() 返回所有 refs/ 下的引用（不含 HEAD）", () => {
    store.write("HEAD", "ref: refs/heads/main");
    store.write("refs/heads/main", "abc");
    store.write("refs/tags/v1", "def");

    const all = store.listAll();
    expect(all).not.toContain("HEAD");
    expect(all).toContain("refs/heads/main");
    expect(all).toContain("refs/tags/v1");
    expect(all).toHaveLength(2);
  });

  test("listAll() 返回排序结果", () => {
    store.write("refs/tags/v2", "222");
    store.write("refs/heads/main", "111");
    store.write("refs/tags/v1", "000");

    expect(store.listAll()).toEqual(["refs/heads/main", "refs/tags/v1", "refs/tags/v2"]);
  });

  test("HEAD 引用可正常读写", () => {
    store.write("HEAD", "ref: refs/heads/main");
    expect(store.read("HEAD")).toBe("ref: refs/heads/main");

    store.write("HEAD", "abc123");
    expect(store.read("HEAD")).toBe("abc123");
  });
});

// ============================================================================
// 事务
// ============================================================================

describe("Sqlite RefTransaction", () => {
  let conn: SqliteConnectionHandle;
  let store: RefStore;

  beforeEach(() => {
    conn = acquireConnection(":memory:");
    conn.db.run("CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, target TEXT NOT NULL)");
    store = createSqliteRefStore(conn);
  });

  afterEach(() => {
    conn.release();
  });

  test("空事务 commit 不报错", () => {
    const tx = store.beginTransaction();
    expect(tx.pendingCount).toBe(0);
    tx.commit();
  });

  test("单条 write + commit", () => {
    const tx = store.beginTransaction();
    tx.write("refs/heads/main", "abc123");
    expect(tx.pendingCount).toBe(1);
    tx.commit();
    expect(store.read("refs/heads/main")).toBe("abc123");
  });

  test("多条 write + commit", () => {
    const tx = store.beginTransaction();
    tx.write("refs/heads/main", "a000");
    tx.write("refs/heads/feature", "b000");
    tx.write("refs/tags/v1", "c000");
    tx.commit();
    expect(store.read("refs/heads/main")).toBe("a000");
    expect(store.read("refs/heads/feature")).toBe("b000");
    expect(store.read("refs/tags/v1")).toBe("c000");
  });

  test("write + delete + commit", () => {
    store.write("refs/heads/feature", "old");
    const tx = store.beginTransaction();
    tx.write("refs/heads/main", "abc");
    tx.delete("refs/heads/feature");
    tx.commit();
    expect(store.read("refs/heads/main")).toBe("abc");
    expect(store.read("refs/heads/feature")).toBeNull();
  });

  test("同 ref 覆盖写入以最后一次为准", () => {
    const tx = store.beginTransaction();
    tx.write("refs/heads/main", "first");
    tx.write("refs/heads/main", "second");
    tx.commit();
    expect(store.read("refs/heads/main")).toBe("second");
  });

  test("先 delete 再 write 同一 ref 写入生效", () => {
    store.write("refs/heads/main", "old");
    const tx = store.beginTransaction();
    tx.delete("refs/heads/main");
    tx.write("refs/heads/main", "new");
    tx.commit();
    expect(store.read("refs/heads/main")).toBe("new");
  });

  test("先 write 再 delete 同一 ref 删除生效", () => {
    store.write("refs/heads/main", "old");
    const tx = store.beginTransaction();
    tx.write("refs/heads/main", "new");
    tx.delete("refs/heads/main");
    tx.commit();
    expect(store.read("refs/heads/main")).toBeNull();
  });

  test("rollback 后存储状态不变", () => {
    store.write("refs/heads/main", "original");
    const tx = store.beginTransaction();
    tx.write("refs/heads/main", "should-not-appear");
    tx.rollback();
    expect(store.read("refs/heads/main")).toBe("original");
  });

  test("rollback 后不能再次 rollback", () => {
    const tx = store.beginTransaction();
    tx.write("refs/heads/main", "abc");
    tx.rollback();
    tx.rollback(); // 第二次无副作用
    expect(store.read("refs/heads/main")).toBeNull();
  });

  test("commit 后不能再次操作", () => {
    const tx = store.beginTransaction();
    tx.write("refs/heads/main", "abc");
    tx.commit();
    expect(() => tx.write("refs/heads/main", "def")).toThrow(TransactionError);
    expect(() => tx.delete("refs/heads/main")).toThrow(TransactionError);
    expect(() => tx.commit()).toThrow(TransactionError);
  });

  test("rollback 后不能再次操作", () => {
    const tx = store.beginTransaction();
    tx.write("refs/heads/main", "abc");
    tx.rollback();
    expect(() => tx.write("refs/heads/main", "def")).toThrow(TransactionError);
    expect(() => tx.delete("refs/heads/main")).toThrow(TransactionError);
    expect(() => tx.commit()).toThrow(TransactionError);
  });

  test("commit 失败自动 rollback（通过 hook 模拟）", () => {
    store.write("refs/heads/main", "original");
    const failHook: RefTransactionHook = {
      onPrepare() {
        throw new Error("abort");
      },
    };
    const tx = store.beginTransaction([failHook]);
    tx.write("refs/heads/main", "will-not-happen");
    expect(() => tx.commit()).toThrow("abort");
    expect(store.read("refs/heads/main")).toBe("original");
  });

  test("pendingCount 正确", () => {
    const tx = store.beginTransaction();
    expect(tx.pendingCount).toBe(0);
    tx.write("refs/heads/a", "1");
    expect(tx.pendingCount).toBe(1);
    tx.write("refs/heads/b", "2");
    expect(tx.pendingCount).toBe(2);
    tx.write("refs/heads/a", "3"); // 覆盖，数量不变
    expect(tx.pendingCount).toBe(2);
    tx.delete("refs/heads/b"); // 覆盖 pending 中的 write，数量不变
    expect(tx.pendingCount).toBe(2);
  });

  test("delete 不存在的 ref 抛出 RefNotFoundError", () => {
    const tx = store.beginTransaction();
    expect(() => tx.delete("refs/heads/nonexistent")).toThrow(RefNotFoundError);
  });

  test("Hook onCommitted 触发", () => {
    let committed = false;
    const hook: RefTransactionHook = {
      onCommitted() {
        committed = true;
      },
    };
    const tx = store.beginTransaction([hook]);
    tx.write("refs/heads/main", "abc");
    tx.commit();
    expect(committed).toBe(true);
  });

  test("Hook onAborted 在 rollback 时触发", () => {
    let aborted = false;
    const hook: RefTransactionHook = {
      onAborted() {
        aborted = true;
      },
    };
    const tx = store.beginTransaction([hook]);
    tx.write("refs/heads/main", "abc");
    tx.rollback();
    expect(aborted).toBe(true);
  });

  test("Hook onAborted 在 commit 失败时触发", () => {
    let aborted = false;
    const failHook: RefTransactionHook = {
      onPrepare() {
        throw new Error("fail");
      },
    };
    const abortHook: RefTransactionHook = {
      onAborted() {
        aborted = true;
      },
    };
    store.write("refs/heads/main", "original");
    const tx = store.beginTransaction([failHook, abortHook]);
    tx.write("refs/heads/main", "will-not-happen");
    expect(() => tx.commit()).toThrow("fail");
    expect(aborted).toBe(true);
    expect(store.read("refs/heads/main")).toBe("original");
  });
});
