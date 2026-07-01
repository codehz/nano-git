/**
 * Reference Transaction 单元测试
 *
 * 覆盖 RefTransaction 的 Memory 和 File 实现的全部场景。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RefNotFoundError, TransactionError } from "@/errors.ts";
import { createFileRefStore } from "@/refs/file.ts";
import { createMemoryRefStore } from "@/refs/memory.ts";

import type { RefStore, RefTransactionHook } from "@/types/refs.ts";

// ============================================================================
// Memory 事务
// ============================================================================

describe("Memory RefTransaction", () => {
  let store: RefStore;

  beforeEach(() => {
    store = createMemoryRefStore();
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
    tx.delete("refs/heads/b"); // 覆盖，数量不变
    expect(tx.pendingCount).toBe(2);
  });

  test("delete 不存在的 ref 抛出 RefNotFoundError", () => {
    const tx = store.beginTransaction();
    expect(() => tx.delete("refs/heads/nonexistent")).toThrow(RefNotFoundError);
  });

  test("delete 不存在的 ref 后 rollback 不报错", () => {
    const tx = store.beginTransaction();
    expect(() => tx.delete("refs/heads/nonexistent")).toThrow(RefNotFoundError);
    tx.rollback(); // rollback 在 write/commit 异常后仍可安全调用
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
    tx.write("refs/heads/main", "new");
    expect(() => tx.commit()).toThrow("fail");
    expect(aborted).toBe(true);
  });

  test("大量 refs（1000 条）", () => {
    const tx = store.beginTransaction();
    const count = 1000;
    for (let i = 0; i < count; i++) {
      tx.write(`refs/heads/branch-${i}`, `000000000000000000000000000000000000000${i % 10}`);
    }
    expect(tx.pendingCount).toBe(count);
    tx.commit();
    for (let i = 0; i < count; i++) {
      expect(store.read(`refs/heads/branch-${i}`)).toBe(
        `000000000000000000000000000000000000000${i % 10}`,
      );
    }
  });
});

// ============================================================================
// Memory 嵌套事务
// ============================================================================

describe("Memory RefTransaction — 嵌套事务", () => {
  test("内部事务抛异常不影响外部事务", () => {
    const store = createMemoryRefStore();
    store.write("refs/heads/main", "original");

    const outer = store.beginTransaction();
    outer.write("refs/heads/main", "outer-value");

    const inner = store.beginTransaction();
    inner.write("refs/heads/feature", "inner-value");
    inner.commit(); // inner 提交成功

    outer.rollback(); // outer 回滚

    // outer 回滚后 main 恢复原值
    expect(store.read("refs/heads/main")).toBe("original");
    // inner 提交的 feature 不受 outer rollback 影响（每个事务独立）
    expect(store.read("refs/heads/feature")).toBe("inner-value");
  });
});

// ============================================================================
// File 事务
// ============================================================================

describe("File RefTransaction", () => {
  let tempDir: string;
  let store: RefStore;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-test-refs-tx-${Date.now()}`);
    mkdirSync(join(tempDir, "refs", "heads"), { recursive: true });
    mkdirSync(join(tempDir, "refs", "tags"), { recursive: true });
    store = createFileRefStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("空事务 commit 不报错", () => {
    const tx = store.beginTransaction();
    tx.commit();
  });

  test("单条 write + commit", () => {
    const tx = store.beginTransaction();
    tx.write("refs/heads/main", "abc123");
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

  test("delete 不存在的 ref 抛出 RefNotFoundError", () => {
    const tx = store.beginTransaction();
    expect(() => tx.delete("refs/heads/nonexistent")).toThrow(RefNotFoundError);
  });

  test("Lock 文件冲突报错", () => {
    const tx1 = store.beginTransaction();
    tx1.write("refs/heads/main", "aaa");
    // 手动创建 lock 文件模拟并发
    const tx2 = store.beginTransaction();
    tx2.write("refs/heads/main", "bbb");
    tx1.commit(); // tx1 先提交，创建了 .lock 然后 rename

    // 此时 .lock 文件已被 rename，所以 tx2 的 commit 应该可以成功创建新的 lock
    // 但为了测试 lock 冲突，我们手动创建一个 lock 文件
    writeFileSync(join(tempDir, "refs/heads/main.lock"), "");
    const tx3 = store.beginTransaction();
    tx3.write("refs/heads/main", "ccc");
    expect(() => tx3.commit()).toThrow(TransactionError);
  });

  test("残留 lock 不影响正常读取", () => {
    store.write("refs/heads/main", "original");
    // 创建残留 lock 文件
    writeFileSync(join(tempDir, "refs/heads/main.lock"), "stale");
    // 读取不受影响
    expect(store.read("refs/heads/main")).toBe("original");
  });

  test("大量 refs（100 条）", () => {
    const tx = store.beginTransaction();
    for (let i = 0; i < 100; i++) {
      tx.write(`refs/heads/branch-${i}`, `000000000000000000000000000000000000000${i}`);
    }
    tx.commit();
    for (let i = 0; i < 100; i++) {
      expect(store.read(`refs/heads/branch-${i}`)).toBe(
        `000000000000000000000000000000000000000${i}`,
      );
    }
  });
});
