/**
 * Packfile Delta 编解码测试
 */

import { describe, test, expect } from "bun:test";

import { DeltaError } from "@/errors.ts";
import { applyDelta, createDelta } from "@/pack/delta/delta.ts";
import { encodeVarint } from "@/pack/utils/utils.ts";

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

  test("delta 指令 0 抛出 DeltaError", () => {
    const base = Buffer.from("base");
    const delta = Buffer.concat([
      encodeVarint(base.length),
      encodeVarint(5),
      Buffer.from([0x00]), // 非法指令 0
    ]);

    expect(() => applyDelta(base, delta)).toThrow(DeltaError);
  });

  test("insert 指令超界抛出 DeltaError", () => {
    const base = Buffer.from("base");
    const delta = Buffer.concat([
      encodeVarint(base.length),
      encodeVarint(10),
      Buffer.from([
        0x0a, // insert 10 字节，但 delta 数据不足
        // 后面只有用来构造完整 varint 的字节，但实际 insert 内容不够
      ]),
    ]);

    expect(() => applyDelta(base, delta)).toThrow(DeltaError);
  });

  test("结果 size 不匹配抛出 DeltaError", () => {
    const base = Buffer.from("hello world");
    // 声明目标大小为 5，但实际 copy 指令输出 11 字节
    const delta = Buffer.concat([
      encodeVarint(base.length),
      encodeVarint(5), // 声明目标大小 5，但实际 copy 全部 11 字节
      Buffer.from([0x80 | 0x01, 0x00, 0x0b]), // copy offset=0, size=11
    ]);

    expect(() => applyDelta(base, delta)).toThrow(DeltaError);
  });

  test("copy 指令的 size 为 0 时实际为 0x10000", () => {
    const base = Buffer.alloc(0x10000, "a");
    // copy 指令只设置 0x01 bit（读取 1 字节 offset），不设置 size bits -> size=0 -> 0x10000
    const delta = Buffer.concat([
      encodeVarint(base.length),
      encodeVarint(0x10000),
      Buffer.from([0x81, 0x00]), // cmd=0x81 (0x80|0x01), offset=0, size=0 -> 0x10000
    ]);

    const result = applyDelta(base, delta);
    expect(result).toHaveLength(0x10000);
    expect(result.toString()).toBe(base.toString());
  });

  test("copy 指令各种 bit 组合", () => {
    // 验证 decodeCopyInstruction 的所有 bit 组合
    const base = Buffer.alloc(0x100, "a");
    // copy offset=0x7f, size=0x3f（使用最简 bit 组合）
    const delta = Buffer.concat([
      encodeVarint(base.length),
      encodeVarint(0x3f),
      Buffer.from([
        0x80 | 0x01 | 0x10, // cmd: 0x01(offset-lsb), 0x10(size-lsb)
        0x7f, // offset = 0x7f
        0x3f, // size = 0x3f
      ]),
    ]);

    const result = applyDelta(base, delta);
    expect(result).toHaveLength(0x3f);
    expect(result.toString()).toBe(base.subarray(0x7f, 0x7f + 0x3f).toString());
  });

  test("空 base 创建 delta", () => {
    const base = Buffer.from("");
    const target = Buffer.from("new data");
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(result.toString()).toBe("new data");
  });

  test("空 target 创建 delta", () => {
    const base = Buffer.from("some data");
    const target = Buffer.from("");
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(result).toHaveLength(0);
  });

  test("空 base 和空 target", () => {
    const base = Buffer.from("");
    const target = Buffer.from("");
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(result).toHaveLength(0);
  });
});
