/**
 * Push 协议报文构建与解析单元测试
 *
 * 测试 buildReceivePackRequest（请求构建）和
 * parseReceivePackResult（响应解析）的编解码正确性。
 */

import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import { parsePktLines, encodePktLine, encodeFlushPkt } from "@/transport/pkt-line.ts";
import {
  buildReceivePackRequest,
  type ReceivePackCommand,
} from "@/transport/receive-pack-request.ts";
import { parseReceivePackResult, ReceivePackResultError } from "@/transport/receive-pack-result.ts";

import type { PktLineData } from "@/transport/pkt-line.ts";

// ============================================================================
// 常量
// ============================================================================

const HASH_A = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const HASH_B = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const ZERO_HASH = sha1("0000000000000000000000000000000000000000");
const MAIN_REF = "refs/heads/main";
const FEATURE_REF = "refs/heads/feature";

// ============================================================================
// buildReceivePackRequest 测试
// ============================================================================

describe("buildReceivePackRequest", () => {
  test("基本格式：单条命令 + packfile", () => {
    const commands: ReceivePackCommand[] = [
      { oldHash: ZERO_HASH, newHash: HASH_A, refName: MAIN_REF },
    ];
    const packfile = Buffer.from("PACKDATA");
    const caps: string[] = [];

    const result = buildReceivePackRequest(commands, packfile, caps);

    // 结果尾部应为 packfile 数据
    expect(result.subarray(result.length - 8).toString()).toBe("PACKDATA");

    // 解析 pkt-line 部分（截掉 packfile 后）
    const pktLinePortion = result.subarray(0, result.length - 8);
    const lines = parsePktLines(pktLinePortion);

    expect(lines.length).toBe(2);
    expect(lines[0]!.type).toBe("data");
    expect(lines[1]!.type).toBe("flush");

    const cmdLine = (lines[0] as PktLineData).payload.toString("utf-8");
    expect(cmdLine).toBe(`${ZERO_HASH} ${HASH_A} ${MAIN_REF}\n`);
  });

  test("首行带 capabilities", () => {
    const commands: ReceivePackCommand[] = [
      { oldHash: ZERO_HASH, newHash: HASH_A, refName: MAIN_REF },
    ];
    const packfile = Buffer.alloc(0);
    const caps = ["report-status", "side-band-64k"];

    const result = buildReceivePackRequest(commands, packfile, caps);
    const lines = parsePktLines(result);

    expect(lines.length).toBe(2);
    expect(lines[0]!.type).toBe("data");

    const cmdLine = (lines[0] as PktLineData).payload.toString("utf-8");
    // capabilities 应跟在 NUL 之后
    expect(cmdLine).toBe(`${ZERO_HASH} ${HASH_A} ${MAIN_REF}\0report-status side-band-64k\n`);
  });

  test("多条命令", () => {
    const commands: ReceivePackCommand[] = [
      { oldHash: ZERO_HASH, newHash: HASH_A, refName: MAIN_REF },
      { oldHash: HASH_A, newHash: HASH_B, refName: FEATURE_REF },
    ];
    const packfile = Buffer.alloc(0);
    const caps: string[] = [];

    const result = buildReceivePackRequest(commands, packfile, caps);
    const lines = parsePktLines(result);

    expect(lines.length).toBe(3); // 2 命令 + 1 flush
    expect(lines[0]!.type).toBe("data");
    expect(lines[1]!.type).toBe("data");
    expect(lines[2]!.type).toBe("flush");

    const line0 = (lines[0] as PktLineData).payload.toString("utf-8");
    const line1 = (lines[1] as PktLineData).payload.toString("utf-8");
    expect(line0).toBe(`${ZERO_HASH} ${HASH_A} ${MAIN_REF}\n`);
    expect(line1).toBe(`${HASH_A} ${HASH_B} ${FEATURE_REF}\n`);
  });

  test("空 packfile（删除分支场景）", () => {
    const commands: ReceivePackCommand[] = [
      { oldHash: HASH_A, newHash: ZERO_HASH, refName: MAIN_REF },
    ];
    const packfile = Buffer.alloc(0);
    const caps: string[] = [];

    const result = buildReceivePackRequest(commands, packfile, caps);

    // 解析 pkt-line，不应有多余数据
    const lines = parsePktLines(result);
    expect(lines.length).toBe(2);
    expect(lines[0]!.type).toBe("data");
    expect(lines[1]!.type).toBe("flush");

    const cmdLine = (lines[0] as PktLineData).payload.toString("utf-8");
    expect(cmdLine).toBe(`${HASH_A} ${ZERO_HASH} ${MAIN_REF}\n`);
  });

  test("至少一条命令（空命令列表抛错）", () => {
    expect(() => {
      buildReceivePackRequest([], Buffer.alloc(0), []);
    }).toThrow("At least one command is required");
  });
});

// ============================================================================
// parseReceivePackResult 测试
// ============================================================================

describe("parseReceivePackResult", () => {
  test("解析 ok 行", () => {
    const data = Buffer.concat([
      encodePktLine("unpack ok\n"),
      encodePktLine("ok refs/heads/main\n"),
      encodeFlushPkt(),
    ]);

    const result = parseReceivePackResult(data);
    expect(result).toHaveLength(1);
    expect(result[0]!.refName).toBe("refs/heads/main");
    expect(result[0]!.success).toBe(true);
    expect(result[0]!.error).toBeUndefined();
  });

  test("解析 ng 行", () => {
    const data = Buffer.concat([
      encodePktLine("unpack ok\n"),
      encodePktLine("ng refs/heads/main non-fast-forward\n"),
      encodeFlushPkt(),
    ]);

    const result = parseReceivePackResult(data);
    expect(result).toHaveLength(1);
    expect(result[0]!.refName).toBe("refs/heads/main");
    expect(result[0]!.success).toBe(false);
    expect(result[0]!.error).toBe("non-fast-forward");
  });

  test("unpack ok 行被跳过", () => {
    const data = Buffer.concat([
      encodePktLine("unpack ok\n"),
      encodePktLine("ok refs/heads/main\n"),
      encodeFlushPkt(),
    ]);

    const result = parseReceivePackResult(data);
    expect(result).toHaveLength(1);
    expect(result[0]!.refName).toBe("refs/heads/main");
    expect(result[0]!.success).toBe(true);
  });

  test("unpack error 行导致报错", () => {
    const data = Buffer.concat([encodePktLine("unpack index error\n"), encodeFlushPkt()]);

    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
    expect(() => parseReceivePackResult(data)).toThrow("index error");
  });

  test("unpack error 后跟随 ng 行仍应先报 unpack 错误", () => {
    const data = Buffer.concat([
      encodePktLine("unpack index error\n"),
      encodePktLine("ng refs/heads/main unpack fail\n"),
      encodeFlushPkt(),
    ]);

    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
  });

  test("多行混合", () => {
    const data = Buffer.concat([
      encodePktLine("unpack ok\n"),
      encodePktLine("ok refs/heads/main\n"),
      encodePktLine("ok refs/heads/feature\n"),
      encodePktLine("ng refs/heads/broken some error\n"),
      encodeFlushPkt(),
    ]);

    const result = parseReceivePackResult(data);
    expect(result).toHaveLength(3);

    expect(result[0]!.refName).toBe("refs/heads/main");
    expect(result[0]!.success).toBe(true);

    expect(result[1]!.refName).toBe("refs/heads/feature");
    expect(result[1]!.success).toBe(true);

    expect(result[2]!.refName).toBe("refs/heads/broken");
    expect(result[2]!.success).toBe(false);
    expect(result[2]!.error).toBe("some error");
  });

  test("空数据返回空列表", () => {
    const result = parseReceivePackResult(Buffer.alloc(0));
    expect(result).toHaveLength(0);
  });

  test("仅 flush-pkt 返回空列表", () => {
    const result = parseReceivePackResult(encodeFlushPkt());
    expect(result).toHaveLength(0);
  });

  test("ng 行缺少错误消息时抛错", () => {
    const data = Buffer.concat([encodePktLine("ng refs/heads/main\n"), encodeFlushPkt()]);

    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
  });

  test("未知状态行抛错", () => {
    const data = Buffer.concat([encodePktLine("unknown data\n"), encodeFlushPkt()]);

    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
  });

  test("缺少 unpack 行时以 ok 开头应报错", () => {
    const data = Buffer.concat([encodePktLine("ok refs/heads/main\n"), encodeFlushPkt()]);

    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
    expect(() => parseReceivePackResult(data)).toThrow(/missing unpack/i);
  });

  test("缺少 unpack 行时以 ng 开头应报错", () => {
    const data = Buffer.concat([
      encodePktLine("ng refs/heads/main some error\n"),
      encodeFlushPkt(),
    ]);

    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
    expect(() => parseReceivePackResult(data)).toThrow(/missing unpack/i);
  });

  test("ok 出现在 unpack 之前应报错", () => {
    const data = Buffer.concat([
      encodePktLine("ok refs/heads/main\n"),
      encodePktLine("unpack ok\n"),
      encodeFlushPkt(),
    ]);

    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
    expect(() => parseReceivePackResult(data)).toThrow(/missing unpack/i);
  });
});
