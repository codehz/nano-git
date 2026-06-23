/**
 * Smart HTTP 传输层 receive-pack request 错误传播测试
 *
 * HTTP 层返回原始 body；协议解析由 decodeReceivePackResponse 完成。
 */

import { describe, test, expect } from "bun:test";

import { createReceivePackHttpClient } from "@/transport/client/push/http.ts";
import { decodeReceivePackResponse } from "@/transport/client/push/response.ts";

describe("decodeReceivePackResponse 错误传播", () => {
  test("无效 pkt-line 响应应传播 PktLineError，而非静默返回空 refUpdates", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => {
      return new Response(Buffer.from("invalid pkt-line data"), {
        status: 200,
        headers: { "content-type": "application/x-git-receive-pack-result" },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any as typeof globalThis.fetch;

    const client = createReceivePackHttpClient("http://dummy.example.com/repo");
    const body = Buffer.from("test body");
    const raw = await client.request(body);

    expect(() => decodeReceivePackResponse(raw)).toThrow();

    globalThis.fetch = originalFetch;
  });
});
