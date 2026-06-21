/**
 * Smart HTTP 传输层 postReceivePack 错误传播测试
 *
 * 验证 postReceivePack 在解析服务端响应时遇到非协议错误（如 PktLineError），
 * 能将错误向上传播，而非静默吞掉后返回空的 refUpdates。
 */

import { describe, test, expect } from "bun:test";

import { createSmartHttpClient } from "@/transport/smart-http.ts";

describe("postReceivePack 错误传播", () => {
  test("无效 pkt-line 响应应传播 PktLineError，而非静默返回空 refUpdates", async () => {
    const originalFetch = globalThis.fetch;

    // Mock fetch 返回合法的 HTTP 响应，但 body 是无效的 pkt-line 数据
    // parsePktLines 遇到 "inva" 不是合法十六进制长度前缀时会抛出 PktLineError
    globalThis.fetch = (async () => {
      return new Response(Buffer.from("invalid pkt-line data"), {
        status: 200,
        headers: { "content-type": "application/x-git-receive-pack-result" },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any as typeof globalThis.fetch;

    const client = createSmartHttpClient("http://dummy.example.com/repo");
    const body = Buffer.from("test body");

    // 应在返回前就抛出异常（PktLineError），而非静默返回空 refUpdates
    expect(client.postReceivePack(body)).rejects.toThrow();

    globalThis.fetch = originalFetch;
  });
});
