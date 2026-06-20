/**
 * refs 模块单元测试
 *
 * 验证独立的 ref 存储和工具函数行为，避免只通过 Repository 间接覆盖。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileRefStore,
  createMemoryRefStore,
  resolveRefHash,
  resolveSymbolicRef,
  validateRefPrefix,
} from "../src/refs/index.ts";
import { CircularReferenceError, RefNotFoundError } from "../src/core/errors.ts";
import { sha1 } from "../src/core/types.ts";

describe("createMemoryRefStore()", () => {
  test("会复制初始 Map，避免外部后续修改污染存储", () => {
    const initial = new Map<string, string>([["HEAD", "ref: refs/heads/main"]]);
    const store = createMemoryRefStore(initial);

    initial.set("refs/heads/main", "1111111111111111111111111111111111111111");

    expect(store.readRaw("refs/heads/main")).toBeNull();
  });

  test("deleteRaw() 对不存在的引用抛出 RefNotFoundError", () => {
    const store = createMemoryRefStore();

    expect(() => store.deleteRaw("refs/heads/missing")).toThrow(RefNotFoundError);
  });

  test("listRaw() 会校验前缀格式", () => {
    const store = createMemoryRefStore();

    expect(() => store.listRaw("refs/heads")).toThrow("Invalid ref prefix");
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

  test("writeRaw() 只规范化末尾换行，不移除前导空白", () => {
    const store = createFileRefStore(tempDir);

    store.writeRaw("refs/heads/main", " 1111111111111111111111111111111111111111\n");

    expect(readFileSync(join(tempDir, "refs", "heads", "main"), "utf-8")).toBe(
      " 1111111111111111111111111111111111111111\n",
    );
    expect(store.readRaw("refs/heads/main")).toBe(" 1111111111111111111111111111111111111111");
  });

  test("deleteRaw() 对不存在的引用抛出 RefNotFoundError", () => {
    const store = createFileRefStore(tempDir);

    expect(() => store.deleteRaw("refs/heads/missing")).toThrow(RefNotFoundError);
  });

  test("listRaw() 返回排序后的引用并校验前缀", () => {
    const store = createFileRefStore(tempDir);

    store.writeRaw("refs/heads/z-last", "1111111111111111111111111111111111111111");
    store.writeRaw("refs/heads/feature/api", "2222222222222222222222222222222222222222");

    expect(store.listRaw("refs/heads/")).toEqual(["refs/heads/feature/api", "refs/heads/z-last"]);
    expect(() => store.listRaw("refs/heads")).toThrow("Invalid ref prefix");
  });

  test("readRaw() 支持读取 packed-refs 中的引用", () => {
    writeFileSync(
      join(tempDir, "packed-refs"),
      "# pack-refs with: peeled fully-peeled sorted\n1111111111111111111111111111111111111111 refs/heads/main\n",
    );
    const store = createFileRefStore(tempDir);

    expect(store.readRaw("refs/heads/main")).toBe("1111111111111111111111111111111111111111");
  });

  test("listRaw() 会合并 loose refs 和 packed-refs", () => {
    writeFileSync(
      join(tempDir, "packed-refs"),
      "1111111111111111111111111111111111111111 refs/heads/main\n2222222222222222222222222222222222222222 refs/heads/release\n",
    );
    const store = createFileRefStore(tempDir);
    store.writeRaw("refs/heads/feature/api", "3333333333333333333333333333333333333333");

    expect(store.listRaw("refs/heads/")).toEqual([
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
