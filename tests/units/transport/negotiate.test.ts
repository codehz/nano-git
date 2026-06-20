/**
 * negotiate（请求生成）单元测试
 *
 * 覆盖场景：
 * - 初始 clone：want + capabilities + done
 * - 多个 want
 * - 增量 fetch：want + 批量 have + done
 * - have 分批（每批 ≤ 32 条 flush 分隔）
 * - 空 haves
 * - 空 capabilities
 * - 空 wants 应抛出错误
 */

import { describe, test, expect } from "bun:test";
import { buildUploadPackRequest } from "../../../src/transport/negotiate.ts";
import { parsePktLines } from "../../../src/transport/pkt-line.ts";
import type { PktLineData } from "../../../src/transport/pkt-line.ts";
import { sha1 } from "../../../src/core/types.ts";

// ============================================================================
// 辅助函数
// ============================================================================

function dataPayload(line: unknown): string {
  if (line && typeof line === "object" && "type" in line) {
    const l = line as { type: string; payload?: Buffer };
    if (l.type === "data" && l.payload) {
      return l.payload.toString("utf-8");
    }
  }
  return "";
}

// ============================================================================
// 测试
// ============================================================================

describe("buildUploadPackRequest()", () => {
  const hash1 = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
  const hash2 = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const hash3 = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

  test("初始 clone：单 want + capabilities + done", () => {
    const body = buildUploadPackRequest([hash1], [], ["multi_ack", "side-band-64k", "ofs-delta"]);
    const lines = parsePktLines(body);

    // want + flush + done + flush = 4 帧
    expect(lines).toHaveLength(4);

    // 第 1 帧：want 行带 capabilities
    const wantLine = dataPayload(lines[0]!);
    expect(wantLine).toBe(`want ${hash1} multi_ack side-band-64k ofs-delta\n`);

    // 第 2 帧：flush
    expect(lines[1]!.type).toBe("flush");

    // 第 3 帧：done
    const doneLine = dataPayload(lines[2]!);
    expect(doneLine).toBe("done\n");

    // 第 4 帧：flush
    expect(lines[3]!.type).toBe("flush");
  });

  test("初始 clone：单 want + 空 capabilities + done", () => {
    const body = buildUploadPackRequest([hash1], [], []);
    const lines = parsePktLines(body);

    expect(lines).toHaveLength(4);
    const wantLine = dataPayload(lines[0]!);
    expect(wantLine).toBe(`want ${hash1}\n`);
  });

  test("多个 want：只有第一条带 capabilities", () => {
    const body = buildUploadPackRequest([hash1, hash2], [], ["multi_ack"]);
    const lines = parsePktLines(body);

    // 2 want + flush + done + flush = 5
    expect(lines).toHaveLength(5);

    const want1 = dataPayload(lines[0]!);
    expect(want1).toBe(`want ${hash1} multi_ack\n`);

    const want2 = dataPayload(lines[1]!);
    expect(want2).toBe(`want ${hash2}\n`);
  });

  test("增量 fetch：want + have + done", () => {
    const body = buildUploadPackRequest([hash1], [hash2, hash3], ["multi_ack", "side-band-64k"]);
    const lines = parsePktLines(body);

    // want + flush + 2 have + flush(haves结束) + done + flush(done后) = 7
    expect(lines).toHaveLength(7);

    expect(lines[0]!.type).toBe("data");
    const wantLine = dataPayload(lines[0]!);
    expect(wantLine).toBe(`want ${hash1} multi_ack side-band-64k\n`);

    expect(lines[1]!.type).toBe("flush");

    expect(dataPayload(lines[2]!)).toBe(`have ${hash2}\n`);
    expect(dataPayload(lines[3]!)).toBe(`have ${hash3}\n`);

    expect(lines[4]!.type).toBe("flush");

    expect(lines[5]!.type).toBe("data");
    expect(dataPayload(lines[5]!)).toBe("done\n");

    expect(lines[6]!.type).toBe("flush");
  });

  test("大量 have 自动分批（每批 ≤ 32）", () => {
    // 创建 35 个 have 哈希（每个都是合法的 40 位十六进制）
    const manyHaves: string[] = [];
    for (let i = 0; i < 35; i++) {
      const idx = i.toString(16).padStart(2, "0");
      manyHaves.push(`0000000000000000000000000000000000${idx}0000`);
    }
    const haves = manyHaves.map((h) => sha1(h));

    const body = buildUploadPackRequest([hash1], haves, ["multi_ack"]);
    const lines = parsePktLines(body);

    // want + flush + 35 have + flush(分批) + flush(haves结束) + done + flush
    let dataCount = 0;
    let flushCount = 0;
    for (const line of lines) {
      if (line.type === "data") dataCount++;
      if (line.type === "flush") flushCount++;
    }

    // 35 have + 1 want + 1 done = 37 data 帧
    expect(dataCount).toBe(37);
    // 1 (want后) + 1 (32批后, i=32时) + 1 (haves结束) + 1 (done后) = 4 flush
    expect(flushCount).toBe(4);
  });

  test("刚好 32 个 have：第 32 条后应有 flush", () => {
    const manyHaves: string[] = [];
    for (let i = 0; i < 32; i++) {
      const idx = i.toString(16).padStart(2, "0");
      manyHaves.push(`0000000000000000000000000000000000${idx}0000`);
    }
    const haves = manyHaves.map((h) => sha1(h));

    const body = buildUploadPackRequest([hash1], haves, ["multi_ack"]);
    const lines = parsePktLines(body);

    // want(0) + flush(1) + 32 have(2-33) + flush(haves结束, 34) + done(35) + flush(done后, 36)
    const flushPositions: number[] = [];
    lines.forEach((line, idx) => {
      if (line.type === "flush") flushPositions.push(idx);
    });

    // flush 应该在位置: 1(want后), 34(haves结束), 36(done后)
    // (32 的倍数时 i=32 不会进入循环，所以没有中间 batch flush)
    expect(flushPositions).toEqual([1, 34, 36]);
  });

  test("空 wants 应抛出错误", () => {
    expect(() => buildUploadPackRequest([], [], ["multi_ack"])).toThrow(
      "At least one want is required",
    );
  });
});
