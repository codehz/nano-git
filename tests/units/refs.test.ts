/**
 * refs 模块单元测试
 *
 * 验证独立的 ref 存储和工具函数行为，避免只通过 Repository 间接覆盖。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CircularReferenceError, RefNotFoundError } from "@/core/errors.ts";
import { sha1 } from "@/core/types.ts";
import {
  createFileRefStore,
  createMemoryRefStore,
  resolveRefHash,
  resolveSymbolicRef,
  validateRefPrefix,
} from "@/refs/index.ts";

describe("createMemoryRefStore()", () => {
  test("会复制初始 Map，避免外部后续修改污染存储", () => {
    const initial = new Map<string, string>([["HEAD", "ref: refs/heads/main"]]);
    const store = createMemoryRefStore(initial);

    initial.set("refs/heads/main", "1111111111111111111111111111111111111111");

    expect(store.read("refs/heads/main")).toBeNull();
  });

  test("delete() 对不存在的引用抛出 RefNotFoundError", () => {
    const store = createMemoryRefStore();

    expect(() => store.delete("refs/heads/missing")).toThrow(RefNotFoundError);
  });

  test("list() 会校验前缀格式", () => {
    const store = createMemoryRefStore();

    expect(() => store.list("refs/heads")).toThrow("Invalid ref prefix");
  });
});

describe("resolveRefHash() / resolveSymbolicRef()", () => {
  test("支持解析多层符号引用", () => {
    const store = createMemoryRefStore(
      new Map<string, string>([
        ["HEAD", "ref: refs/heads/current"],
        ["refs/heads/current", "ref: refs/heads/main"],
        ["refs/heads/main", "1111111111111111111111111111111111111111"],
      ]),
    );

    expect(resolveSymbolicRef(store, "HEAD")).toBe("refs/heads/main");
    expect(resolveRefHash(store, "HEAD")).toBe(sha1("1111111111111111111111111111111111111111"));
  });

  test("检测符号引用循环", () => {
    const store = createMemoryRefStore(
      new Map<string, string>([
        ["HEAD", "ref: refs/heads/main"],
        ["refs/heads/main", "ref: HEAD"],
      ]),
    );

    expect(() => resolveRefHash(store, "HEAD")).toThrow(CircularReferenceError);
    expect(() => resolveSymbolicRef(store, "HEAD")).toThrow(CircularReferenceError);
  });
});

describe("createFileRefStore()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-refs-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("write() 只规范化末尾换行，不移除前导空白", () => {
    const store = createFileRefStore(tempDir);

    store.write("refs/heads/main", " 1111111111111111111111111111111111111111\n");

    expect(readFileSync(join(tempDir, "refs", "heads", "main"), "utf-8")).toBe(
      " 1111111111111111111111111111111111111111\n",
    );
    expect(store.read("refs/heads/main")).toBe(" 1111111111111111111111111111111111111111");
  });

  test("delete() 对不存在的引用抛出 RefNotFoundError", () => {
    const store = createFileRefStore(tempDir);

    expect(() => store.delete("refs/heads/missing")).toThrow(RefNotFoundError);
  });

  test("list() 返回排序后的引用并校验前缀", () => {
    const store = createFileRefStore(tempDir);

    store.write("refs/heads/z-last", "1111111111111111111111111111111111111111");
    store.write("refs/heads/feature/api", "2222222222222222222222222222222222222222");

    expect(store.list("refs/heads/")).toEqual(["refs/heads/feature/api", "refs/heads/z-last"]);
    expect(() => store.list("refs/heads")).toThrow("Invalid ref prefix");
  });

  test("read() 支持读取 packed-refs 中的引用", () => {
    writeFileSync(
      join(tempDir, "packed-refs"),
      "# pack-refs with: peeled fully-peeled sorted\n1111111111111111111111111111111111111111 refs/heads/main\n",
    );
    const store = createFileRefStore(tempDir);

    expect(store.read("refs/heads/main")).toBe("1111111111111111111111111111111111111111");
  });

  test("list() 会合并 loose refs 和 packed-refs", () => {
    writeFileSync(
      join(tempDir, "packed-refs"),
      "1111111111111111111111111111111111111111 refs/heads/main\n2222222222222222222222222222222222222222 refs/heads/release\n",
    );
    const store = createFileRefStore(tempDir);
    store.write("refs/heads/feature/api", "3333333333333333333333333333333333333333");

    expect(store.list("refs/heads/")).toEqual([
      "refs/heads/feature/api",
      "refs/heads/main",
      "refs/heads/release",
    ]);
  });
});

describe("validateRefPrefix()", () => {
  test("拒绝不以斜杠结尾的 refs 前缀", () => {
    expect(() => validateRefPrefix("refs/tags")).toThrow("Invalid ref prefix");
  });
});
