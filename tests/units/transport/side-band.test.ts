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

import {
  allocBytes,
  bytesEqual,
  bytesToUtf8,
  concatBytes,
  copyBytes,
  utf8ToBytes,
  writeU32BE,
} from "../../helpers/bytes.ts";
import { encodePktLine } from "@/transport/protocol/pkt-line.ts";
import {
  extractPackfile,
  extractProgress,
  extractRawPackfile,
  extractSideBandFatal,
  SideBandError,
} from "@/transport/protocol/side-band.ts";

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
function sideBandFrame(channel: number, data: string | Uint8Array): Uint8Array {
  const payload = typeof data === "string" ? utf8ToBytes(data) : data;
  return encodePktLine(concatBytes(Uint8Array.from([channel]), payload));
}

// ============================================================================
// 测试
// ============================================================================

describe("extractPackfile()", () => {
  test("从单帧中提取 packfile", () => {
    const data = concatBytes(sideBandFrame(1, "packfile data here"));
    const packfile = extractPackfile(data);
    expect(bytesToUtf8(packfile)).toBe("packfile data here");
  });

  test("从多帧中拼接 packfile", () => {
    const data = concatBytes(
      sideBandFrame(1, "part1"),
      sideBandFrame(1, "part2"),
      sideBandFrame(1, "part3"),
    );
    const packfile = extractPackfile(data);
    expect(bytesToUtf8(packfile)).toBe("part1part2part3");
  });

  test("在混合 channel 中提取 packfile", () => {
    const data = concatBytes(
      sideBandFrame(2, "progress: 10%\n"),
      sideBandFrame(1, "binary-pack-data-1"),
      sideBandFrame(2, "progress: 50%\n"),
      sideBandFrame(1, "binary-pack-data-2"),
      sideBandFrame(2, "progress: 100%\n"),
    );
    const packfile = extractPackfile(data);
    expect(bytesToUtf8(packfile)).toBe("binary-pack-data-1binary-pack-data-2");
  });

  test("二进制 packfile 数据", () => {
    const binary = Uint8Array.from([0x50, 0x41, 0x43, 0x4b, 0x00, 0xff, 0xfe, 0x01]);
    const data = concatBytes(sideBandFrame(1, binary));
    const packfile = extractPackfile(data);
    expect(bytesEqual(packfile, binary)).toBe(true);
  });

  test("无 packfile 数据应抛出错误", () => {
    const data = concatBytes(sideBandFrame(2, "only progress"));
    expect(() => extractPackfile(data)).toThrow(SideBandError);
  });

  test("空数据应抛出错误", () => {
    expect(() => extractPackfile(allocBytes(0))).toThrow(SideBandError);
  });

  test("channel 3 致命错误应抛出", () => {
    const data = concatBytes(
      sideBandFrame(1, "some data"),
      sideBandFrame(3, "fatal: repository not found"),
    );
    expect(() => extractPackfile(data)).toThrow(SideBandError);
    expect(() => extractPackfile(data)).toThrow("repository not found");
  });
});

describe("extractProgress()", () => {
  test("从单帧中提取进度消息", () => {
    const data = concatBytes(sideBandFrame(2, "Receiving objects:  10% (1/10)\n"));
    const msgs = extractProgress(data);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toBe("Receiving objects:  10% (1/10)\n");
  });

  test("从多帧中收集进度消息", () => {
    const data = concatBytes(
      sideBandFrame(2, "Receiving objects:  10% (1/10)\n"),
      sideBandFrame(2, "Receiving objects:  50% (5/10)\n"),
      sideBandFrame(2, "Receiving objects: 100% (10/10)\n"),
    );
    const msgs = extractProgress(data);
    expect(msgs).toHaveLength(3);
  });

  test("在混合 channel 中收集进度消息", () => {
    const data = concatBytes(
      sideBandFrame(2, "progress: start\n"),
      sideBandFrame(1, "data"),
      sideBandFrame(2, "progress: end\n"),
    );
    const msgs = extractProgress(data);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toBe("progress: start\n");
    expect(msgs[1]).toBe("progress: end\n");
  });

  test("无进度消息返回空数组", () => {
    const data = concatBytes(sideBandFrame(1, "only packfile"));
    const msgs = extractProgress(data);
    expect(msgs).toHaveLength(0);
  });

  test("channel 3 致命错误应抛出", () => {
    const data = concatBytes(sideBandFrame(3, "fatal: error occurred"));
    expect(() => extractProgress(data)).toThrow(SideBandError);
  });
});

describe("未知 channel", () => {
  test("未知 channel 应被忽略", () => {
    const data = concatBytes(
      sideBandFrame(4, "unknown"),
      sideBandFrame(1, "packfile"),
      sideBandFrame(5, "also unknown"),
    );
    const packfile = extractPackfile(data);
    expect(bytesToUtf8(packfile)).toBe("packfile");
  });

  test("仅包含未知 channel 应有错误", () => {
    const data = concatBytes(sideBandFrame(4, "unknown"));
    expect(() => extractPackfile(data)).toThrow(SideBandError);
  });
});

// ============================================================================
// extractRawPackfile（非 side-band 响应解析）
// ============================================================================

describe("extractRawPackfile()", () => {
  /** 构造一个最小 packfile（12 字节头部 + 20 字节校验和） */
  function createMinimalPackfile(): Uint8Array {
    const header = allocBytes(12);
    copyBytes(header, 0, utf8ToBytes("PACK")); // 签名
    writeU32BE(header, 4, 2); // 版本
    writeU32BE(header, 8, 0); // 对象数 = 0（空 packfile）
    // 不需要真实校验和，测试只关心提取逻辑
    return header;
  }

  test("从 NAK + raw PACK 响应中提取 packfile", () => {
    const rawPack = createMinimalPackfile();
    const nakLine = encodePktLine("NAK\n");
    const data = concatBytes(nakLine, rawPack);

    const result = extractRawPackfile(data);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(rawPack.length);
    expect(bytesToUtf8(result).startsWith("PACK")).toBe(true);
  });

  test("从 flush-pkt + raw PACK 响应中提取 packfile", () => {
    const rawPack = createMinimalPackfile();
    const nakLine = encodePktLine("NAK\n");
    const flushPkt = utf8ToBytes("0000");
    const data = concatBytes(nakLine, flushPkt, rawPack);

    const result = extractRawPackfile(data);
    expect(result.length).toBe(rawPack.length);
    expect(bytesToUtf8(result).startsWith("PACK")).toBe(true);
  });

  test("packfile 数据保持完整不变", () => {
    const rawPack = createMinimalPackfile();
    const ackLine = encodePktLine("ACK somehash\n");
    const data = concatBytes(ackLine, rawPack);

    const result = extractRawPackfile(data);
    expect(bytesEqual(result, rawPack)).toBe(true);
  });

  test("仅有 pkt-lines 无 packfile 应抛出 SideBandError", () => {
    const data = encodePktLine("NAK\n");
    expect(() => extractRawPackfile(data)).toThrow(SideBandError);
  });

  test("空数据应抛出 SideBandError", () => {
    expect(() => extractRawPackfile(allocBytes(0))).toThrow(SideBandError);
  });

  test("无前导 pkt-lines 的纯 packfile 数据也能提取", () => {
    const rawPack = createMinimalPackfile();
    const result = extractRawPackfile(rawPack);
    expect(bytesEqual(result, rawPack)).toBe(true);
  });

  test("多行 ACK + flush-pkt + packfile", () => {
    const rawPack = createMinimalPackfile();
    const lines = [
      encodePktLine("ACK 1111111111111111111111111111111111111111\n"),
      encodePktLine("ACK 2222222222222222222222222222222222222222\n"),
      utf8ToBytes("0000"),
      rawPack,
    ];
    const data = concatBytes(...lines);

    const result = extractRawPackfile(data);
    expect(bytesEqual(result, rawPack)).toBe(true);
  });
});

// ============================================================================
// extractSideBandFatal（side-band 致命错误检测）
// ============================================================================

describe("extractSideBandFatal()", () => {
  test("side-band 数据中检测到 fatal 应返回消息", () => {
    const data = concatBytes(
      sideBandFrame(1, "some data"),
      sideBandFrame(3, "fatal: repository not found"),
    );
    expect(extractSideBandFatal(data)).toBe("fatal: repository not found");
  });

  test("无 fatal 的 side-band 数据应返回 null", () => {
    const data = concatBytes(sideBandFrame(1, "packfile data"), sideBandFrame(2, "progress: ok\n"));
    expect(extractSideBandFatal(data)).toBeNull();
  });

  test("非 side-band 数据（NAK + raw PACK）不应抛出，应返回 null", () => {
    const rawPack = allocBytes(12);
    copyBytes(rawPack, 0, utf8ToBytes("PACK"));
    writeU32BE(rawPack, 4, 2);
    writeU32BE(rawPack, 8, 0);
    const data = concatBytes(encodePktLine("NAK\n"), rawPack);
    expect(extractSideBandFatal(data)).toBeNull();
  });
});
