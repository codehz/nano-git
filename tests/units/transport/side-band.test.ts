/**
 * side-band 多路解复用单元测试
 *
 * 覆盖场景：
 * - channel 1（packfile）数据提取与拼接
 * - channel 2（progress）消息收集
 * - channel 3（fatal）错误报告
 * - 混合 channel 数据
 * - 空数据
 * - 未知 channel 忽略
 */

import { describe, test, expect } from "bun:test";
import { encodePktLine } from "../../../src/transport/pkt-line.ts";
import {
  extractPackfile,
  extractProgress,
  SideBandError,
} from "../../../src/transport/side-band.ts";

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 构造 side-band 数据帧
 *
 * @param channel - channel 编号（1=packfile, 2=progress, 3=fatal）
 * @param data - 负载数据
 * @returns pkt-line 编码的 Buffer
 */
function sideBandFrame(channel: number, data: string | Buffer): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return encodePktLine(Buffer.concat([Buffer.from([channel]), payload]));
}

// ============================================================================
// 测试
// ============================================================================

describe("extractPackfile()", () => {
  test("从单帧中提取 packfile", () => {
    const data = Buffer.concat([sideBandFrame(1, "packfile data here")]);
    const packfile = extractPackfile(data);
    expect(packfile.toString("utf-8")).toBe("packfile data here");
  });

  test("从多帧中拼接 packfile", () => {
    const data = Buffer.concat([
      sideBandFrame(1, "part1"),
      sideBandFrame(1, "part2"),
      sideBandFrame(1, "part3"),
    ]);
    const packfile = extractPackfile(data);
    expect(packfile.toString("utf-8")).toBe("part1part2part3");
  });

  test("在混合 channel 中提取 packfile", () => {
    const data = Buffer.concat([
      sideBandFrame(2, "progress: 10%\n"),
      sideBandFrame(1, "binary-pack-data-1"),
      sideBandFrame(2, "progress: 50%\n"),
      sideBandFrame(1, "binary-pack-data-2"),
      sideBandFrame(2, "progress: 100%\n"),
    ]);
    const packfile = extractPackfile(data);
    expect(packfile.toString("utf-8")).toBe("binary-pack-data-1binary-pack-data-2");
  });

  test("二进制 packfile 数据", () => {
    const binary = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0x00, 0xff, 0xfe, 0x01]);
    const data = Buffer.concat([sideBandFrame(1, binary)]);
    const packfile = extractPackfile(data);
    expect(Buffer.compare(packfile, binary)).toBe(0);
  });

  test("无 packfile 数据应抛出错误", () => {
    const data = Buffer.concat([sideBandFrame(2, "only progress")]);
    expect(() => extractPackfile(data)).toThrow(SideBandError);
  });

  test("空数据应抛出错误", () => {
    expect(() => extractPackfile(Buffer.alloc(0))).toThrow(SideBandError);
  });

  test("channel 3 致命错误应抛出", () => {
    const data = Buffer.concat([
      sideBandFrame(1, "some data"),
      sideBandFrame(3, "fatal: repository not found"),
    ]);
    expect(() => extractPackfile(data)).toThrow(SideBandError);
    expect(() => extractPackfile(data)).toThrow("repository not found");
  });
});

describe("extractProgress()", () => {
  test("从单帧中提取进度消息", () => {
    const data = Buffer.concat([sideBandFrame(2, "Receiving objects:  10% (1/10)\n")]);
    const msgs = extractProgress(data);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toBe("Receiving objects:  10% (1/10)\n");
  });

  test("从多帧中收集进度消息", () => {
    const data = Buffer.concat([
      sideBandFrame(2, "Receiving objects:  10% (1/10)\n"),
      sideBandFrame(2, "Receiving objects:  50% (5/10)\n"),
      sideBandFrame(2, "Receiving objects: 100% (10/10)\n"),
    ]);
    const msgs = extractProgress(data);
    expect(msgs).toHaveLength(3);
  });

  test("在混合 channel 中收集进度消息", () => {
    const data = Buffer.concat([
      sideBandFrame(2, "progress: start\n"),
      sideBandFrame(1, "data"),
      sideBandFrame(2, "progress: end\n"),
    ]);
    const msgs = extractProgress(data);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toBe("progress: start\n");
    expect(msgs[1]).toBe("progress: end\n");
  });

  test("无进度消息返回空数组", () => {
    const data = Buffer.concat([sideBandFrame(1, "only packfile")]);
    const msgs = extractProgress(data);
    expect(msgs).toHaveLength(0);
  });

  test("channel 3 致命错误应抛出", () => {
    const data = Buffer.concat([sideBandFrame(3, "fatal: error occurred")]);
    expect(() => extractProgress(data)).toThrow(SideBandError);
  });
});

describe("未知 channel", () => {
  test("未知 channel 应被忽略", () => {
    const data = Buffer.concat([
      sideBandFrame(4, "unknown"),
      sideBandFrame(1, "packfile"),
      sideBandFrame(5, "also unknown"),
    ]);
    const packfile = extractPackfile(data);
    expect(packfile.toString("utf-8")).toBe("packfile");
  });

  test("仅包含未知 channel 应有错误", () => {
    const data = Buffer.concat([sideBandFrame(4, "unknown")]);
    expect(() => extractPackfile(data)).toThrow(SideBandError);
  });
});
