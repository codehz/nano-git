/**
 * transport/client/upload-pack/fetch.ts 单元测试
 *
 * 覆盖 parseV2FetchResponse（纯函数，可脱离 HTTP 测试）
 * v2Fetch 需要 mock transport，此处只测响应解析
 */

import { describe, test, expect } from "bun:test";

import { parseV2FetchResponse } from "@/transport/client/upload-pack/fetch.ts";
import {
  encodePktLine,
  encodeFlushPkt,
  encodeDelimiterPkt,
} from "@/transport/protocol/pkt-line.ts";

function pkt(text: string): Buffer {
  return encodePktLine(text);
}

describe("parseV2FetchResponse()", () => {
  test("仅有 acknowledgments + NAK（无 packfile）", () => {
    const buf = Buffer.concat([pkt("acknowledgments\n"), pkt("NAK\n"), encodeFlushPkt()]);

    const result = parseV2FetchResponse(buf, false, false);
    expect(result.acknowledgments?.acks).toEqual([]);
    expect(result.acknowledgments?.nak).toBe(true);
    expect(result.packfile).toBeUndefined();
  });

  test("有 ACK 的响应", () => {
    const buf = Buffer.concat([
      pkt("acknowledgments\n"),
      pkt("ACK 95d09f2b10159347eece71399a7e2e907ea3df4f\n"),
      pkt("ACK aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d\n"),
      pkt("ready\n"),
      encodeDelimiterPkt(),
      encodeFlushPkt(),
    ]);

    const result = parseV2FetchResponse(buf, false, false);
    expect(result.acknowledgments?.acks).toHaveLength(2);
    expect(result.acknowledgments?.acks[0]).toBe("95d09f2b10159347eece71399a7e2e907ea3df4f");
    expect(result.acknowledgments?.acks[1]).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    expect(result.acknowledgments?.ready).toBe(true);
  });

  test("packfile 数据提取", () => {
    // packfile 节头后跟 pkt-line 编码的包数据
    // 每个数据帧需要 channel 字节: 0x01 = packfile 数据
    const pktLine1 = Buffer.concat([
      Buffer.from([0x01]),
      Buffer.from("PACK\u0000\u0000\u0000\u0002..."),
    ]);
    const pktLine2 = Buffer.concat([Buffer.from([0x01]), Buffer.from("morepackdata")]);
    const buf = Buffer.concat([
      pkt("packfile\n"),
      encodePktLine(pktLine1),
      encodePktLine(pktLine2),
      encodeFlushPkt(),
    ]);

    const result = parseV2FetchResponse(buf, false, false);
    expect(result.packfile).toBeDefined();
    expect(result.packfile!.length).toBeGreaterThan(0);
    expect(result.packfile!.toString()).toContain("PACK");
  });

  test("空 packfile 节返回 undefined", () => {
    const buf = Buffer.concat([pkt("packfile\n"), encodeFlushPkt()]);

    const result = parseV2FetchResponse(buf, true, false);
    // 节头后无数据帧，packfileFrames 为空 → packfile 应为 undefined
    expect(result.packfile).toBeUndefined();
  });

  test("无节头的空响应", () => {
    const buf = Buffer.concat([pkt("\n"), encodeFlushPkt()]);

    const result = parseV2FetchResponse(buf, false, false);
    expect(result.acknowledgments).toBeUndefined();
    expect(result.packfile).toBeUndefined();
  });
});
