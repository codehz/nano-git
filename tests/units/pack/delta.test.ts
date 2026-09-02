/**
 * Packfile Delta 编解码测试
 */

import { describe, test, expect } from "bun:test";

import { allocBytes, bytes, bytesToUtf8, concatBytes } from "../../helpers/bytes.ts";
import { DeltaError } from "@/errors.ts";
import { applyDelta, createDelta } from "@/pack/delta/delta.ts";
import { encodeVarint } from "@/pack/utils/utils.ts";

function filledBytes(size: number, char: string): Uint8Array {
  const buf = allocBytes(size);
  buf.fill(char.charCodeAt(0));
  return buf;
}

describe("Delta 编解码", () => {
  test("创建和应用 delta（简单修改）", () => {
    const base = bytes("hello world");
    const target = bytes("hello git");
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(bytesToUtf8(result)).toBe("hello git");
  });

  test("创建和应用 delta（完全相同）", () => {
    const base = bytes("identical content");
    const target = bytes("identical content");
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(bytesToUtf8(result)).toBe("identical content");
  });

  test("创建和应用 delta（完全不同）", () => {
    const base = bytes("completely different");
    const target = bytes("new content here");
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(bytesToUtf8(result)).toBe("new content here");
  });

  test("创建和应用 delta（大文件）", () => {
    const base = filledBytes(10000, "a");
    const target = filledBytes(10000, "b");
    target.fill("a".charCodeAt(0), 0, 5000);
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(result).toEqual(target);
  });

  test("应用非法 copy 指令时报错", () => {
    const base = bytes("short");
    const delta = concatBytes(
      encodeVarint(base.length),
      encodeVarint(4),
      Uint8Array.from([0x91, 0x10, 0x04]),
    );
    expect(() => applyDelta(base, delta)).toThrow(DeltaError);
  });

  test("delta 指令 0 抛出 DeltaError", () => {
    const base = bytes("base");
    const delta = concatBytes(encodeVarint(base.length), encodeVarint(5), Uint8Array.from([0x00]));
    expect(() => applyDelta(base, delta)).toThrow(DeltaError);
  });

  test("insert 指令超界抛出 DeltaError", () => {
    const base = bytes("base");
    const delta = concatBytes(encodeVarint(base.length), encodeVarint(10), Uint8Array.from([0x0a]));
    expect(() => applyDelta(base, delta)).toThrow(DeltaError);
  });

  test("结果 size 不匹配抛出 DeltaError", () => {
    const base = bytes("hello world");
    const delta = concatBytes(
      encodeVarint(base.length),
      encodeVarint(5),
      Uint8Array.from([0x80 | 0x01, 0x00, 0x0b]),
    );
    expect(() => applyDelta(base, delta)).toThrow(DeltaError);
  });

  test("copy 指令的 size 为 0 时实际为 0x10000", () => {
    const base = filledBytes(0x10000, "a");
    const delta = concatBytes(
      encodeVarint(base.length),
      encodeVarint(0x10000),
      Uint8Array.from([0x81, 0x00]),
    );
    const result = applyDelta(base, delta);
    expect(result).toHaveLength(0x10000);
    expect(bytesToUtf8(result)).toBe(bytesToUtf8(base));
  });

  test("copy 指令各种 bit 组合", () => {
    const base = filledBytes(0x100, "a");
    const delta = concatBytes(
      encodeVarint(base.length),
      encodeVarint(0x3f),
      Uint8Array.from([0x80 | 0x01 | 0x10, 0x7f, 0x3f]),
    );
    const result = applyDelta(base, delta);
    expect(result).toHaveLength(0x3f);
    expect(bytesToUtf8(result)).toBe(bytesToUtf8(base.subarray(0x7f, 0x7f + 0x3f)));
  });

  test("空 base 创建 delta", () => {
    const base = bytes("");
    const target = bytes("new data");
    const delta = createDelta(base, target);
    const result = applyDelta(base, delta);
    expect(bytesToUtf8(result)).toBe("new data");
  });
});
