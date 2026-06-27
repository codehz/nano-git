/**
 * 文件系统 Refs 存储特有行为测试
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RefNotFoundError } from "@/core/errors.ts";
import { createFileRefStore } from "@/refs/file.ts";

describe("createFileRefStore()", () => {
  let tempDir: string;
  let store: ReturnType<typeof createFileRefStore>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nano-git-refs-file-test-"));
    mkdirSync(join(tempDir, "refs"), { recursive: true });
    store = createFileRefStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("read() 可回退到 packed-refs", () => {
    writeFileSync(join(tempDir, "packed-refs"), "111111 refs/heads/main\n");

    expect(store.read("refs/heads/main")).toBe("111111");
  });

  test("loose ref 优先于 packed-refs", () => {
    writeFileSync(join(tempDir, "packed-refs"), "111111 refs/heads/main\n");
    store.write("refs/heads/main", "222222");

    expect(store.read("refs/heads/main")).toBe("222222");
  });

  test("list() 合并 loose refs 与 packed-refs 并去重", () => {
    writeFileSync(
      join(tempDir, "packed-refs"),
      ["333333 refs/heads/z-final", "111111 refs/heads/main", "444444 refs/tags/v1", ""].join("\n"),
    );
    store.write("refs/heads/main", "222222");
    store.write("refs/heads/feature/api", "abcabc");

    expect(store.list("refs/heads/")).toEqual([
      "refs/heads/feature/api",
      "refs/heads/main",
      "refs/heads/z-final",
    ]);
  });

  test("delete() 删除 packed-refs 条目及其 peeled 行", () => {
    writeFileSync(
      join(tempDir, "packed-refs"),
      [
        "# pack-refs with: peeled fully-peeled",
        "aaaaaaaa refs/tags/v1",
        "^bbbbbbbb",
        "cccccccc refs/heads/main",
        "",
      ].join("\n"),
    );

    store.delete("refs/tags/v1");

    expect(store.read("refs/tags/v1")).toBeNull();
    expect(readFileSync(join(tempDir, "packed-refs"), "utf8")).toBe(
      ["# pack-refs with: peeled fully-peeled", "cccccccc refs/heads/main", ""].join("\n"),
    );
  });

  test("delete() 在 loose 和 packed 都不存在时抛出 RefNotFoundError", () => {
    expect(() => store.delete("refs/heads/missing")).toThrow(RefNotFoundError);
  });
});
