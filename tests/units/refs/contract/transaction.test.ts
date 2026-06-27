/**
 * Refs 合同测试：事务语义
 */
import { describe, expect, test } from "bun:test";

import { refStoreBackends } from "./contract.ts";
import { RefNotFoundError, TransactionError } from "@/core/errors.ts";

import type { ReadonlyRefTransaction, RefTransactionHook } from "@/core/types/refs.ts";

describe("RefStore contract: transaction", () => {
  describe.each(refStoreBackends)("$name", ({ createStore }) => {
    test("空事务 commit 不报错", () => {
      using session = createStore();
      const tx = session.store.beginTransaction();

      expect(tx.pendingCount).toBe(0);
      tx.commit();
    });

    test("write / delete / commit 原子生效", () => {
      using session = createStore();
      const { store } = session;

      store.write("refs/heads/feature", "old");

      const tx = store.beginTransaction();
      tx.write("refs/heads/main", "abc");
      tx.delete("refs/heads/feature");
      tx.commit();

      expect(store.read("refs/heads/main")).toBe("abc");
      expect(store.read("refs/heads/feature")).toBeNull();
    });

    test("同 ref 多次操作以最后一次为准", () => {
      using session = createStore();
      const { store } = session;

      store.write("refs/heads/main", "old");

      const tx = store.beginTransaction();
      tx.write("refs/heads/main", "first");
      tx.write("refs/heads/main", "second");
      tx.delete("refs/heads/main");
      tx.write("refs/heads/main", "final");
      tx.commit();

      expect(store.read("refs/heads/main")).toBe("final");
    });

    test("rollback 后存储状态不变且可重复调用", () => {
      using session = createStore();
      const { store } = session;

      store.write("refs/heads/main", "original");

      const tx = store.beginTransaction();
      tx.write("refs/heads/main", "should-not-appear");
      tx.rollback();
      tx.rollback();

      expect(store.read("refs/heads/main")).toBe("original");
    });

    test("commit 或 rollback 后不能再次操作", () => {
      using session = createStore();
      const { store } = session;

      const committedTx = store.beginTransaction();
      committedTx.write("refs/heads/main", "abc");
      committedTx.commit();

      expect(() => committedTx.write("refs/heads/main", "def")).toThrow(TransactionError);
      expect(() => committedTx.delete("refs/heads/main")).toThrow(TransactionError);
      expect(() => committedTx.commit()).toThrow(TransactionError);

      const rolledBackTx = store.beginTransaction();
      rolledBackTx.write("refs/heads/feature", "abc");
      rolledBackTx.rollback();

      expect(() => rolledBackTx.write("refs/heads/feature", "def")).toThrow(TransactionError);
      expect(() => rolledBackTx.delete("refs/heads/feature")).toThrow(TransactionError);
      expect(() => rolledBackTx.commit()).toThrow(TransactionError);
    });

    test("pendingCount 正确反映唯一待提交 ref 数量", () => {
      using session = createStore();
      const tx = session.store.beginTransaction();

      expect(tx.pendingCount).toBe(0);
      tx.write("refs/heads/a", "1");
      expect(tx.pendingCount).toBe(1);
      tx.write("refs/heads/b", "2");
      expect(tx.pendingCount).toBe(2);
      tx.write("refs/heads/a", "3");
      expect(tx.pendingCount).toBe(2);
      tx.delete("refs/heads/b");
      expect(tx.pendingCount).toBe(2);
    });

    test("delete 不存在的 ref 抛出 RefNotFoundError", () => {
      using session = createStore();
      const tx = session.store.beginTransaction();

      expect(() => tx.delete("refs/heads/nonexistent")).toThrow(RefNotFoundError);
    });

    test("hook 可观察事务快照并在成功提交时触发 committed", () => {
      using session = createStore();
      const { store } = session;

      store.write("refs/heads/main", "old");

      let preparedSnapshot: ReadonlyRefTransaction | undefined;
      let committedSnapshot: ReadonlyRefTransaction | undefined;
      const hook: RefTransactionHook = {
        onPrepare(tx) {
          preparedSnapshot = tx;
        },
        onCommitted(tx) {
          committedSnapshot = tx;
        },
      };

      const tx = store.beginTransaction([hook]);
      tx.delete("refs/heads/main");
      tx.write("refs/tags/v1", "tag");
      tx.commit();

      expect(preparedSnapshot).toEqual({
        pendingCount: 2,
        writes: [{ ref: "refs/tags/v1", content: "tag" }],
        deletes: [{ ref: "refs/heads/main" }],
      });
      expect(committedSnapshot).toEqual(preparedSnapshot);
      expect(store.read("refs/tags/v1")).toBe("tag");
      expect(store.read("refs/heads/main")).toBeNull();
    });

    test("hook 可在 rollback 和 commit 失败时触发 aborted", () => {
      using session = createStore();
      const { store } = session;

      let rollbackAborted = false;
      const rollbackHook: RefTransactionHook = {
        onAborted() {
          rollbackAborted = true;
        },
      };

      const rollbackTx = store.beginTransaction([rollbackHook]);
      rollbackTx.write("refs/heads/main", "abc");
      rollbackTx.rollback();
      expect(rollbackAborted).toBe(true);

      store.write("refs/heads/main", "original");

      let commitAborted = false;
      const failHook: RefTransactionHook = {
        onPrepare() {
          throw new Error("abort");
        },
      };
      const abortHook: RefTransactionHook = {
        onAborted() {
          commitAborted = true;
        },
      };

      const failTx = store.beginTransaction([failHook, abortHook]);
      failTx.write("refs/heads/main", "will-not-happen");
      expect(() => failTx.commit()).toThrow("abort");
      expect(commitAborted).toBe(true);
      expect(store.read("refs/heads/main")).toBe("original");
    });
  });
});
