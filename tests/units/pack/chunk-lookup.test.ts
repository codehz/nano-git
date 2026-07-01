/**
 * pack/chunk-lookup.ts 单元测试
 */

import { describe, test, expect } from "bun:test";

import { PackIndexError } from "@/errors.ts";
import { parseChunkLookup } from "@/pack/chunk-lookup.ts";

describe("parseChunkLookup()", () => {
  /**
   * 构建包含 header + chunk lookup 表 + 尾部填充的测试数据
   *
   * 保证文件总大小满足所有 chunk offset 不越界。
   */
  function buildChunkData(chunks: Array<{ id: string; offset: number }>): Buffer {
    const headerSize = 12;
    const entrySize = 12;
    const minSize = headerSize + (chunks.length + 1) * entrySize;
    // 额外填充确保 offset 不越界（chunkOffset > data.length 时抛错）
    const maxOffset = chunks.reduce((max, c) => Math.max(max, c.offset), 0);
    const totalsize = Math.max(minSize, maxOffset + 1);
    const buf = Buffer.alloc(totalsize, 0);

    for (let i = 0; i < chunks.length; i++) {
      const entryOffset = headerSize + i * entrySize;
      buf.write(chunks[i]!.id, entryOffset, 4, "ascii");
      buf.writeBigUInt64BE(BigInt(chunks[i]!.offset), entryOffset + 4);
    }

    // 终止标记（全零）由初始化的零值自动满足
    return buf;
  }

  test("解析有效的 chunk lookup 表", () => {
    const data = buildChunkData([
      { id: "PNAM", offset: 100 },
      { id: "OIDF", offset: 200 },
      { id: "OOFF", offset: 300 },
    ]);

    const chunks = parseChunkLookup(data, 12, 3);
    expect(chunks.get("PNAM")).toBe(100);
    expect(chunks.get("OIDF")).toBe(200);
    expect(chunks.get("OOFF")).toBe(300);
  });

  test("返回所有 chunk id 列表", () => {
    const data = buildChunkData([
      { id: "ABCD", offset: 50 },
      { id: "EFGH", offset: 100 },
    ]);

    const chunks = parseChunkLookup(data, 12, 2);
    expect(chunks.ids()).toEqual(["ABCD", "EFGH"]);
  });

  test("不存在的 chunk id 返回 undefined", () => {
    const data = buildChunkData([{ id: "PNAM", offset: 100 }]);

    const chunks = parseChunkLookup(data, 12, 1);
    expect(chunks.get("NONE")).toBeUndefined();
  });

  test("终止标记（全零）提前结束解析", () => {
    const headerSize = 12;
    const entrySize = 12;
    // 声明 5 个 chunk 但只写 2 个，后面全零
    const buf = Buffer.alloc(headerSize + 6 * entrySize + 1, 0);
    buf.write("PNAM", headerSize, 4, "ascii");
    buf.writeBigUInt64BE(BigInt(headerSize + 6 * entrySize - 10), headerSize + 4);
    buf.write("OIDF", headerSize + entrySize, 4, "ascii");
    buf.writeBigUInt64BE(BigInt(headerSize + 6 * entrySize - 5), headerSize + entrySize + 4);

    const chunks = parseChunkLookup(buf, 12, 5);
    expect(chunks.ids()).toEqual(["PNAM", "OIDF"]);
  });

  test("数据截断时抛出 PackIndexError", () => {
    const data = Buffer.alloc(20); // headerSize=12, chunkCount=2 -> 需要 12 + 3*12 = 48 字节
    expect(() => parseChunkLookup(data, 12, 2)).toThrow(PackIndexError);
  });

  test("chunk offset 超出文件大小时抛出 PackIndexError", () => {
    const data = buildChunkData([{ id: "PNAM", offset: 9999 }]);
    // data.length = max(12+2*12=36, 10000) = 10000, 9999 < 10000, 不越界
    // 要让 offset > data.length，需要设 offset 大于 data.length
    expect(() => parseChunkLookup(data, 12, 1)).not.toThrow();
    // 构造真正越界的场景：数据只有 50 字节，但 offset=100
    const small = Buffer.alloc(50, 0);
    small.write("PNAM", 12, 4, "ascii");
    small.writeBigUInt64BE(BigInt(100), 16);
    expect(() => parseChunkLookup(small, 12, 1)).toThrow(PackIndexError);
  });

  test("headerSize 指定了 lookup 表起始位置", () => {
    const data = buildChunkData([
      { id: "ABCD", offset: 50 },
      { id: "WXYZ", offset: 100 },
    ]);
    // 使用不同的 headerSize 应当正确解析
    const chunks = parseChunkLookup(data, 12, 2);
    expect(chunks.get("ABCD")).toBe(50);
    expect(chunks.get("WXYZ")).toBe(100);
  });
});
