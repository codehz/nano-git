/**
 * Packfile Delta 编解码测试
 */

import { describe, test, expect } from "bun:test";

import { applyDelta, createDelta } from "../../../../src/odb/pack/delta.ts";
import { encodeVarint } from "../../../../src/odb/pack/utils.ts";
import { DeltaError } from "../../../../src/core/errors.ts";

describe("Delta 编解码", () => {
  test("创建和应用 delta（简单修改）", () => {
    const base = Buffer.from("hello world");
    const target = Buffer.from("hello git");
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(result.toString("utf-8")).toBe("hello git");
  });

  test("创建和应用 delta（完全相同）", () => {
    const base = Buffer.from("identical content");
    const target = Buffer.from("identical content");
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(result.toString("utf-8")).toBe("identical content");
  });

  test("创建和应用 delta（完全不同）", () => {
    const base = Buffer.from("completely different");
    const target = Buffer.from("new content here");
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(result.toString("utf-8")).toBe("new content here");
  });

  test("创建和应用 delta（大文件）", () => {
    const base = Buffer.alloc(10000, "a");
    const target = Buffer.alloc(10000, "b");
    target.fill("a", 0, 5000); // 前 5000 字节相同
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(result).toEqual(target);
  });

  test("应用非法 copy 指令时报错", () => {
    const base = Buffer.from("short");
    const delta = Buffer.concat([
      encodeVarint(base.length),
      encodeVarint(4),
      Buffer.from([
        0x91, // copy 指令，带 1 字节 offset 和 1 字节 size
        0x10, // offset = 16
        0x04, // size = 4
      ]),
    ]);

    expect(() => applyDelta(base, delta)).toThrow(DeltaError);
  });
});
