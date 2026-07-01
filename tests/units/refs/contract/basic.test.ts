/**
 * Refs 合同测试：基础读写与枚举语义
 */
import { describe, expect, test } from "bun:test";

import { refStoreBackends } from "./contract.ts";
import { RefNotFoundError } from "@/errors.ts";

describe("RefStore contract: basic", () => {
  describe.each(refStoreBackends)("$name", ({ createStore }) => {
    test("read() 不存在的引用返回 null", () => {
      using session = createStore();
      expect(session.store.read("refs/heads/main")).toBeNull();
    });

    test("write() + read() 基本写入读取", () => {
      using session = createStore();
      const { store } = session;

      store.write("refs/heads/main", "abc123");

      expect(store.read("refs/heads/main")).toBe("abc123");
    });

    test("write() 规范化末尾换行但保留前导空白", () => {
      using session = createStore();
      const { store } = session;

      store.write("refs/heads/main", " abc123\n\n\n");

      expect(store.read("refs/heads/main")).toBe(" abc123");
    });

    test("write() 覆盖已有引用", () => {
      using session = createStore();
      const { store } = session;

      store.write("refs/heads/main", "old");
      store.write("refs/heads/main", "new");

      expect(store.read("refs/heads/main")).toBe("new");
    });

    test("delete() 删除已有引用", () => {
      using session = createStore();
      const { store } = session;

      store.write("refs/heads/main", "abc123");
      store.delete("refs/heads/main");

      expect(store.read("refs/heads/main")).toBeNull();
    });

    test("delete() 对不存在的引用抛出 RefNotFoundError", () => {
      using session = createStore();
      expect(() => session.store.delete("refs/heads/missing")).toThrow(RefNotFoundError);
    });

    test("list() 返回指定前缀下的引用，按名称排序", () => {
      using session = createStore();
      const { store } = session;

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
      using session = createStore();
      const { store } = session;

      store.write("refs/heads/main", "abc");
      store.write("refs/tags/v1", "def");

      expect(store.list("refs/heads/")).toEqual(["refs/heads/main"]);
      expect(store.list("refs/tags/")).toEqual(["refs/tags/v1"]);
    });

    test("list() 校验前缀格式", () => {
      using session = createStore();
      const { store } = session;

      expect(() => store.list("refs/heads")).toThrow("Invalid ref prefix");
      expect(() => store.list("invalid")).toThrow("Invalid ref prefix");
    });

    test("listAll() 返回所有 refs/ 下的引用且不含 HEAD", () => {
      using session = createStore();
      const { store } = session;

      store.write("HEAD", "ref: refs/heads/main");
      store.write("refs/heads/main", "abc");
      store.write("refs/tags/v1", "def");

      expect(store.listAll()).toEqual(["refs/heads/main", "refs/tags/v1"]);
    });

    test("HEAD 引用可正常读写", () => {
      using session = createStore();
      const { store } = session;

      store.write("HEAD", "ref: refs/heads/main");
      expect(store.read("HEAD")).toBe("ref: refs/heads/main");

      store.write("HEAD", "abc123");
      expect(store.read("HEAD")).toBe("abc123");
    });
  });
});
