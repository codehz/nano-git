/**
 * 文件系统对象存储特有行为测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeObject } from "@/objects/raw.ts";
import { createFileObjectStore } from "@/odb/file.ts";
import { sha1 } from "@/types/index.ts";

import type { GitBlob } from "@/types/index.ts";

describe("createFileObjectStore()", () => {
  let tempDir: string;
  let store: ReturnType<typeof createFileObjectStore>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-test-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
    store = createFileObjectStore(tempDir);
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("写入并读取 blob 对象", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("hello world"),
    };
    const hash = writeObject(store, blob);
    expect(hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));

    const read = store.read(hash);
    expect(read.type).toBe("blob");
    if (read.type === "blob") {
      expect(read.content.toString("utf-8")).toBe("hello world");
    }
  });

  test("对象文件存储在正确的路径", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("hello world"),
    };
    const hash = writeObject(store, blob);
    const expectedPath = join(tempDir, "objects", hash.slice(0, 2), hash.slice(2));
    expect(existsSync(expectedPath)).toBe(true);
  });
});
