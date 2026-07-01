/**
 * transport/client/receive-pack/response.ts 单元测试
 *
 * 覆盖 decodeReceivePackResponse 纯函数
 */

import { describe, test, expect } from "bun:test";

import {
  decodeReceivePackResponse,
  ReceivePackResponseError,
} from "@/transport/client/receive-pack/response.ts";
import { encodePktLine, encodeFlushPkt } from "@/transport/protocol/pkt-line.ts";

/**
 * 构造 side-band 帧
 *
 * @param channel - 侧信道编号（0x01=packfile/report-status, 0x02=progress, 0x03=fatal）
 * @param content - 帧内容
 */
function sideBandPkt(channel: number, content: string | Buffer): Buffer {
  const payload = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  return encodePktLine(Buffer.concat([Buffer.from([channel]), payload]));
}

/**
 * 构造空 side-band 帧（仅 channel 字节，无内容）
 */
function sideBandEmptyPkt(channel: number): Buffer {
  return encodePktLine(Buffer.from([channel]));
}

describe("decodeReceivePackResponse()", () => {
  test("非 side-band 编码：裸 report-status", () => {
    const data = Buffer.concat([
      encodePktLine("unpack ok\n"),
      encodePktLine("ok refs/heads/main\n"),
      encodeFlushPkt(),
    ]);
    const result = decodeReceivePackResponse(data);

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.refName).toBe("refs/heads/main");
    expect(result.refUpdates[0]!.success).toBe(true);
    expect(result.progress).toEqual([]);
  });

  test("side-band channel 1：report-status", () => {
    const reportStatus = Buffer.concat([
      encodePktLine("unpack ok\n"),
      encodePktLine("ok refs/heads/main\n"),
      encodeFlushPkt(),
    ]);
    const data = Buffer.concat([sideBandPkt(0x01, reportStatus), encodeFlushPkt()]);
    const result = decodeReceivePackResponse(data);

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.refName).toBe("refs/heads/main");
    expect(result.refUpdates[0]!.success).toBe(true);
  });

  test("side-band channel 2：progress 消息", () => {
    const data = Buffer.concat([
      sideBandPkt(
        0x01,
        Buffer.concat([
          encodePktLine("unpack ok\n"),
          encodePktLine("ok refs/heads/main\n"),
          encodeFlushPkt(),
        ]),
      ),
      sideBandPkt(0x02, "Counting objects: 5\n"),
      sideBandPkt(0x02, "Compressing objects: 100%\n"),
      encodeFlushPkt(),
    ]);
    const result = decodeReceivePackResponse(data);

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
    expect(result.progress).toHaveLength(2);
    expect(result.progress[0]).toBe("Counting objects: 5");
    expect(result.progress[1]).toBe("Compressing objects: 100%");
  });

  test("side-band channel 3：fatal error", () => {
    const data = Buffer.concat([sideBandPkt(0x03, "fatal: pack too large\n"), encodeFlushPkt()]);
    expect(() => decodeReceivePackResponse(data)).toThrow(ReceivePackResponseError);
    expect(() => decodeReceivePackResponse(data)).toThrow(/pack too large/);
  });

  test("混合 side-band channel（report-status + progress）", () => {
    const reportStatus = Buffer.concat([
      encodePktLine("unpack ok\n"),
      encodePktLine("ok refs/heads/main\n"),
      encodePktLine("ok refs/heads/feature\n"),
      encodeFlushPkt(),
    ]);
    const data = Buffer.concat([
      sideBandPkt(0x01, reportStatus),
      sideBandPkt(0x02, "Total 3, reused 0\n"),
      encodeFlushPkt(),
    ]);
    const result = decodeReceivePackResponse(data);

    expect(result.refUpdates).toHaveLength(2);
    expect(result.progress).toHaveLength(1);
    expect(result.progress[0]).toBe("Total 3, reused 0");
  });

  test("空数据返回空结果", () => {
    const result = decodeReceivePackResponse(Buffer.alloc(0));
    expect(result.refUpdates).toEqual([]);
    expect(result.progress).toEqual([]);
  });

  test("仅 flush 的响应", () => {
    const result = decodeReceivePackResponse(encodeFlushPkt());
    expect(result.refUpdates).toEqual([]);
    expect(result.progress).toEqual([]);
  });

  test("side-band channel 1 跨多帧拼接 report-status", () => {
    // 模拟 channel 1 数据跨两帧，每帧包含 pkt-line 编码的 report-status 片段
    // 拼接后应为完整 pkt-line 数据流
    const part1 = encodePktLine("unpack ok\n");
    const part2 = Buffer.concat([encodePktLine("ok refs/heads/main\n"), encodeFlushPkt()]);

    const data = Buffer.concat([
      sideBandPkt(0x01, part1),
      sideBandPkt(0x01, part2),
      encodeFlushPkt(),
    ]);
    const result = decodeReceivePackResponse(data);

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.refName).toBe("refs/heads/main");
    expect(result.refUpdates[0]!.success).toBe(true);
  });

  test("过短的 side-band payload 被跳过（不足 2 字节）", () => {
    // channel 字节 + 空内容 = 1 字节 payload，小于 length check 的 2
    const data = Buffer.concat([sideBandEmptyPkt(0x01), encodeFlushPkt()]);
    const result = decodeReceivePackResponse(data);

    expect(result.refUpdates).toEqual([]);
    expect(result.progress).toEqual([]);
  });

  test("仅 channel 2 无 channel 1 时 refUpdates 为空", () => {
    const data = Buffer.concat([sideBandPkt(0x02, "Counting objects\n"), encodeFlushPkt()]);
    const result = decodeReceivePackResponse(data);

    expect(result.refUpdates).toEqual([]);
    expect(result.progress).toHaveLength(1);
    expect(result.progress[0]).toBe("Counting objects");
  });
});
