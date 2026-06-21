/**
 * pkt-line 帧编解码单元测试
 */

import { describe, test, expect } from "bun:test";

import {
  encodePktLine,
  encodeFlushPkt,
  encodeDelimiterPkt,
  encodeResponseEndPkt,
  parsePktLines,
  PktLineError,
} from "@/transport/pkt-line.ts";

import type { PktLineData } from "@/transport/pkt-line.ts";

// ============================================================================
// 编码
// ============================================================================

describe("encodePktLine()", () => {
  test("编码字符串 payload", () => {
    const buf = encodePktLine("hello");
    expect(buf.toString("utf-8")).toBe("0009hello");
  });

  test("编码 Buffer payload", () => {
    const buf = encodePktLine(Buffer.from("world", "utf-8"));
    expect(buf.toString("utf-8")).toBe("0009world");
  });

  test("编码空 payload（0004）", () => {
    const buf = encodePktLine("");
    expect(buf.toString("utf-8")).toBe("0004");
  });

  test("编码最大长度 payload（65520 字节）", () => {
    const payload = "a".repeat(65520);
    const buf = encodePktLine(payload);
    expect(buf.length).toBe(65524);
    expect(buf.subarray(0, 4).toString("utf-8")).toBe("FFF4");
  });

  test("payload 超长应抛出 PktLineError", () => {
    const payload = "a".repeat(65521);
    expect(() => encodePktLine(payload)).toThrow(PktLineError);
  });
});

describe("特殊帧编码", () => {
  test("encodeFlushPkt", () => {
    const buf = encodeFlushPkt();
    expect(buf.toString("utf-8")).toBe("0000");
    expect(buf.length).toBe(4);
  });

  test("encodeDelimiterPkt", () => {
    const buf = encodeDelimiterPkt();
    expect(buf.toString("utf-8")).toBe("0001");
    expect(buf.length).toBe(4);
  });

  test("encodeResponseEndPkt", () => {
    const buf = encodeResponseEndPkt();
    expect(buf.toString("utf-8")).toBe("0002");
    expect(buf.length).toBe(4);
  });
});

// ============================================================================
// 解码
// ============================================================================

describe("parsePktLines()", () => {
  test("解析单个数据帧", () => {
    const data = Buffer.from("0009hello", "utf-8");
    const lines = parsePktLines(data);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.type).toBe("data");
    const line = lines[0] as PktLineData;
    expect(line.payload.toString("utf-8")).toBe("hello");
  });

  test("解析 flush-pkt", () => {
    const data = encodeFlushPkt();
    const lines = parsePktLines(data);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.type).toBe("flush");
  });

  test("解析 delimiter-pkt", () => {
    const data = encodeDelimiterPkt();
    const lines = parsePktLines(data);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.type).toBe("delimiter");
  });

  test("解析 response-end-pkt", () => {
    const data = encodeResponseEndPkt();
    const lines = parsePktLines(data);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.type).toBe("response-end");
  });

  test("解析多个数据帧", () => {
    const data = Buffer.concat([
      encodePktLine("hello"),
      encodePktLine("world"),
      encodePktLine("foo"),
    ]);
    const lines = parsePktLines(data);
    expect(lines).toHaveLength(3);
    expect((lines[0] as PktLineData).payload.toString("utf-8")).toBe("hello");
    expect((lines[1] as PktLineData).payload.toString("utf-8")).toBe("world");
    expect((lines[2] as PktLineData).payload.toString("utf-8")).toBe("foo");
  });

  test("解析混合帧序列", () => {
    const data = Buffer.concat([encodePktLine("hello"), encodeFlushPkt()]);
    const lines = parsePktLines(data);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.type).toBe("data");
    expect((lines[0] as PktLineData).payload.toString("utf-8")).toBe("hello");
    expect(lines[1]!.type).toBe("flush");
  });

  test("解析空 payload（0004）", () => {
    const data = Buffer.from("0004", "utf-8");
    const lines = parsePktLines(data);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.type).toBe("data");
    expect((lines[0] as PktLineData).payload.length).toBe(0);
  });

  test("空缓冲区返回空列表", () => {
    const lines = parsePktLines(Buffer.alloc(0));
    expect(lines).toHaveLength(0);
  });
});

// ============================================================================
// 错误处理
// ============================================================================

describe("parsePktLines() 错误处理", () => {
  test("非法的十六进制长度字段应抛出 PktLineError", () => {
    const data = Buffer.from("00ZZinvalid", "utf-8");
    expect(() => parsePktLines(data)).toThrow(PktLineError);
  });

  test("长度前缀截断应抛出 PktLineError", () => {
    const data = Buffer.from("00", "utf-8");
    expect(() => parsePktLines(data)).toThrow(PktLineError);
  });

  test("长度声明大于缓冲区剩余应抛出 PktLineError", () => {
    // 声明 000A（10 字节）但只有 4 字节 payload 数据
    const data = Buffer.from("000A1234", "utf-8");
    expect(() => parsePktLines(data)).toThrow(PktLineError);
  });

  test("长度小于 4 的非法数据帧应抛出 PktLineError", () => {
    // 0003 表示总长度 3，但数据帧最小总长度为 4（0004）
    const data = Buffer.from("0003", "utf-8");
    expect(() => parsePktLines(data)).toThrow(PktLineError);
  });

  test("长度超过 65524 应抛出 PktLineError", () => {
    const data = Buffer.from("FFFF", "utf-8");
    expect(() => parsePktLines(data)).toThrow(PktLineError);
  });
});

// ============================================================================
// 往返一致性
// ============================================================================

describe("编解码往返", () => {
  test("数据帧编码再解码保持一致", () => {
    const original = "Hello, pkt-line!";
    const encoded = encodePktLine(original);
    const decoded = parsePktLines(encoded);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.type).toBe("data");
    expect((decoded[0] as PktLineData).payload.toString("utf-8")).toBe(original);
  });

  test("flush-pkt 编码再解码保持一致", () => {
    const encoded = encodeFlushPkt();
    const decoded = parsePktLines(encoded);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.type).toBe("flush");
  });

  test("delimiter-pkt 编码再解码保持一致", () => {
    const encoded = encodeDelimiterPkt();
    const decoded = parsePktLines(encoded);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.type).toBe("delimiter");
  });

  test("response-end-pkt 编码再解码保持一致", () => {
    const encoded = encodeResponseEndPkt();
    const decoded = parsePktLines(encoded);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.type).toBe("response-end");
  });

  test("中文字符编码再解码保持一致", () => {
    const original = "你好，世界！";
    const encoded = encodePktLine(original);
    const decoded = parsePktLines(encoded);
    expect((decoded[0] as PktLineData).payload.toString("utf-8")).toBe(original);
  });

  test("二进制数据编码再解码保持一致", () => {
    const original = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f]);
    const encoded = encodePktLine(original);
    const decoded = parsePktLines(encoded);
    expect(Buffer.compare((decoded[0] as PktLineData).payload, original)).toBe(0);
  });
});
