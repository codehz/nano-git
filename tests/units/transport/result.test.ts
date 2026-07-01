/**
 * transport/client/receive-pack/result.ts 单元测试
 *
 * 覆盖 parseReceivePackResult 纯函数
 */

import { describe, test, expect } from "bun:test";

import {
  parseReceivePackResult,
  ReceivePackResultError,
} from "@/transport/client/receive-pack/result.ts";
import { encodePktLine, encodeFlushPkt } from "@/transport/protocol/pkt-line.ts";

describe("parseReceivePackResult()", () => {
  test("成功更新：unpack ok + ok ref", () => {
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

  test("多条成功更新", () => {
    const data = Buffer.concat([
      encodePktLine("unpack ok\n"),
      encodePktLine("ok refs/heads/main\n"),
      encodePktLine("ok refs/heads/feature\n"),
      encodeFlushPkt(),
    ]);
    const result = parseReceivePackResult(data);

    expect(result).toHaveLength(2);
    expect(result[0]!.refName).toBe("refs/heads/main");
    expect(result[0]!.success).toBe(true);
    expect(result[1]!.refName).toBe("refs/heads/feature");
    expect(result[1]!.success).toBe(true);
  });

  test("服务端拒绝：ng ref 带错误消息", () => {
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

  test("ng 行不带错误消息抛出异常", () => {
    const data = Buffer.concat([
      encodePktLine("unpack ok\n"),
      // ng 行缺少错误信息（没有空格分隔的错误消息）
      encodePktLine("ng refs/heads/main\n"),
      encodeFlushPkt(),
    ]);
    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
    expect(() => parseReceivePackResult(data)).toThrow(/missing error message/i);
  });

  test("缺少 unpack 状态行抛出异常", () => {
    const data = Buffer.concat([encodePktLine("ok refs/heads/main\n"), encodeFlushPkt()]);
    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
    expect(() => parseReceivePackResult(data)).toThrow(/missing unpack status/i);
  });

  test("unpack 失败抛出异常", () => {
    const data = Buffer.concat([encodePktLine("unpack nok\n"), encodeFlushPkt()]);
    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
    expect(() => parseReceivePackResult(data)).toThrow(/failed to unpack/i);
  });

  test("重复 unpack 行抛出异常", () => {
    const data = Buffer.concat([
      encodePktLine("unpack ok\n"),
      encodePktLine("ok refs/heads/main\n"),
      encodePktLine("unpack ok\n"),
      encodeFlushPkt(),
    ]);
    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
    expect(() => parseReceivePackResult(data)).toThrow(/duplicate unpack/i);
  });

  test("未知状态行抛出异常", () => {
    const data = Buffer.concat([
      encodePktLine("unpack ok\n"),
      encodePktLine("invalid refs/heads/main\n"),
      encodeFlushPkt(),
    ]);
    expect(() => parseReceivePackResult(data)).toThrow(ReceivePackResultError);
    expect(() => parseReceivePackResult(data)).toThrow(/unexpected status/i);
  });

  test("空数据返回空列表", () => {
    const result = parseReceivePackResult(Buffer.alloc(0));
    expect(result).toEqual([]);
  });

  test("仅 flush 的响应返回空列表", () => {
    const result = parseReceivePackResult(encodeFlushPkt());
    expect(result).toEqual([]);
  });

  test("ok 行带额外空格依然能被正确解析", () => {
    const data = Buffer.concat([
      encodePktLine("unpack ok\n"),
      encodePktLine("ok refs/heads/main\n"),
      encodeFlushPkt(),
    ]);
    const result = parseReceivePackResult(data);
    expect(result).toHaveLength(1);
    expect(result[0]!.refName).toBe("refs/heads/main");
  });
});
