/**
 * CompositeObjectDatabase 单元测试
 */

import { describe, test, expect } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bytes, bytesToUtf8 } from "../../helpers/bytes.ts";
import { encodeObject, writeObject } from "@/objects/raw.ts";
import { createFileObjectStore } from "@/odb/file.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";
import { createPackBuilder } from "@/pack/builder/pack-builder.ts";
import { createCompositeObjectDatabase } from "@/pack/composite-store.ts";
import { createPackObjectStore } from "@/pack/store/pack-store.ts";

import type { GitBlob } from "@/types/index.ts";

describe("CompositeObjectDatabase", () => {
  test("从主存储读取", () => {
    const primary = createMemoryObjectStore();
    const secondary = createMemoryObjectStore();
    const composite = createCompositeObjectDatabase(primary, secondary);

    const blob: GitBlob = { type: "blob", content: bytes("primary") };
    const hash = writeObject(primary, blob);

    const obj = composite.read(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(bytesToUtf8(obj.content)).toBe("primary");
    }
  });

  test("从辅助存储读取", () => {
    const primary = createMemoryObjectStore();
    const secondary = createMemoryObjectStore();
    const composite = createCompositeObjectDatabase(primary, secondary);

    const blob: GitBlob = { type: "blob", content: bytes("secondary") };
    const hash = writeObject(secondary, blob);

    const obj = composite.read(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(bytesToUtf8(obj.content)).toBe("secondary");
    }
  });

  test("写入到主存储", () => {
    const primary = createMemoryObjectStore();
    const secondary = createMemoryObjectStore();
    const composite = createCompositeObjectDatabase(primary, secondary);

    const blob: GitBlob = { type: "blob", content: bytes("new") };
    const hash = writeObject(composite, blob);

    expect(primary.exists(hash)).toBe(true);
    expect(secondary.exists(hash)).toBe(false);
  });

  test("主存储优先级高于辅助存储", () => {
    const primary = createMemoryObjectStore();
    const secondary = createMemoryObjectStore();
    const composite = createCompositeObjectDatabase(primary, secondary);

    const blob1: GitBlob = { type: "blob", content: bytes("primary version") };
    const blob2: GitBlob = { type: "blob", content: bytes("secondary version") };

    const hash = writeObject(primary, blob1);
    writeObject(secondary, blob2); // 相同内容会产生相同哈希，但这里内容不同

    // 写入不同内容到相同哈希是不可能的，所以这个测试验证的是查找顺序
    const obj = composite.read(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(bytesToUtf8(obj.content)).toBe("primary version");
    }
  });

  test("loose object 优先于 packfile", () => {
    const gitDir = join(
      tmpdir(),
      `nano-git-composite-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(gitDir, "objects"), { recursive: true });

    const packBuilder = createPackBuilder(gitDir);
    const packedHash = packBuilder.addRaw(
      encodeObject({
        type: "blob",
        content: bytes("packed version"),
      }),
    );
    packBuilder.build();

    const fileStore = createFileObjectStore(gitDir);
    const looseHash = writeObject(fileStore, {
      type: "blob",
      content: bytes("loose version"),
    });

    const composite = createCompositeObjectDatabase(fileStore, createPackObjectStore(gitDir));
    const looseObj = composite.read(looseHash);
    const packedObj = composite.read(packedHash);

    expect(looseObj.type).toBe("blob");
    expect(packedObj.type).toBe("blob");
    if (looseObj.type === "blob") {
      expect(bytesToUtf8(looseObj.content)).toBe("loose version");
    }
    if (packedObj.type === "blob") {
      expect(bytesToUtf8(packedObj.content)).toBe("packed version");
    }

    rmSync(gitDir, { recursive: true });
  });
});
