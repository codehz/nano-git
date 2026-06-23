/**
 * PackObjectStore 单元测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeObject } from "@/objects/raw.ts";
import { createPackBuilder } from "@/pack/pack-builder.ts";
import { createPackObjectStore } from "@/pack/pack-store.ts";

import type { GitBlob } from "@/core/types.ts";

describe("PackObjectStore", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-pack-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  test("从 packfile 读取对象", () => {
    const gitDir = tempDir;
    mkdirSync(join(gitDir, "objects", "pack"), { recursive: true });

    // 创建 packfile
    const builder = createPackBuilder(gitDir);
    const blob: GitBlob = { type: "blob", content: Buffer.from("test content") };
    const hash = builder.addRaw(encodeObject(blob));
    builder.build();

    // 读取
    const store = createPackObjectStore(gitDir);
    expect(store.exists(hash)).toBe(true);

    const obj = store.read(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("test content");
    }
  });

  test("支持从多个 packfile 读取对象", () => {
    const gitDir = tempDir;
    mkdirSync(join(gitDir, "objects", "pack"), { recursive: true });

    const builder1 = createPackBuilder(gitDir);
    const hash1 = builder1.addRaw(encodeObject({ type: "blob", content: Buffer.from("pack one") }));
    builder1.build();

    const builder2 = createPackBuilder(gitDir);
    const hash2 = builder2.addRaw(encodeObject({ type: "blob", content: Buffer.from("pack two") }));
    builder2.build();

    const store = createPackObjectStore(gitDir);

    expect(store.packCount).toBe(2);
    expect(store.exists(hash1)).toBe(true);
    expect(store.exists(hash2)).toBe(true);

    const obj1 = store.read(hash1);
    const obj2 = store.read(hash2);
    expect(obj1.type).toBe("blob");
    expect(obj2.type).toBe("blob");
    if (obj1.type === "blob") {
      expect(obj1.content.toString("utf-8")).toBe("pack one");
    }
    if (obj2.type === "blob") {
      expect(obj2.content.toString("utf-8")).toBe("pack two");
    }
  });

  test("PackObjectStore 只提供读取接口", () => {
    const gitDir = tempDir;
    const store = createPackObjectStore(gitDir);

    expect("write" in store).toBe(false);
  });

  test("refresh() 后能看到新增的 packfile", () => {
    const gitDir = tempDir;
    mkdirSync(join(gitDir, "objects", "pack"), { recursive: true });

    const store = createPackObjectStore(gitDir);
    expect(store.packCount).toBe(0);

    const builder = createPackBuilder(gitDir);
    builder.addRaw(encodeObject({ type: "blob", content: Buffer.from("after refresh") }));
    builder.build();

    store.refresh();
    expect(store.packCount).toBe(1);
  });
});
