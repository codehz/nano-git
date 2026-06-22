/**
 * Smart HTTP 传输层 upload-pack request 测试
 *
 * HTTP 层只返回原始 body；协议解码由 decodeUploadPackResponse 完成。
 */

import { describe, test, expect } from "bun:test";

import { encodePktLine } from "@/transport/pkt-line.ts";
import { createUploadPackHttpClient } from "@/transport/smart-http.ts";
import { decodeUploadPackResponse } from "@/transport/upload-pack-response.ts";

// ============================================================================
// 辅助函数
// ============================================================================

/** 构造 side-band pkt-line 帧 */
function sideBandFrame(channel: number, data: string | Buffer): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return encodePktLine(Buffer.concat([Buffer.from([channel]), payload]));
}

// ============================================================================
// upload-pack side-band 致命错误传播
// ============================================================================

describe("decodeUploadPackResponse side-band 致命错误", () => {
  test("channel 3 致命错误应传播，而非返回空 packfile", async () => {
    const originalFetch = globalThis.fetch;

    const sideBandData = Buffer.concat([
      sideBandFrame(2, "Receiving objects: 0%\n"),
      sideBandFrame(3, "fatal: repository 'my-repo' not found\n"),
    ]);

    globalThis.fetch = (async () => {
      return new Response(sideBandData, {
        status: 200,
        headers: { "content-type": "application/x-git-upload-pack-result" },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any as typeof globalThis.fetch;

    const client = createUploadPackHttpClient("http://dummy.example.com/repo");
    const body = Buffer.from("test body");
    const raw = await client.request(body);

    expect(() => decodeUploadPackResponse(raw)).toThrow("fatal: repository 'my-repo' not found");

    globalThis.fetch = originalFetch;
  });

  test("channel 3 混合 packfile 数据的响应也应传播致命错误", async () => {
    const originalFetch = globalThis.fetch;

    const sideBandData = Buffer.concat([
      sideBandFrame(1, Buffer.from([0x50, 0x41, 0x43, 0x4b])),
      sideBandFrame(2, "progress: almost done\n"),
      sideBandFrame(3, "fatal: unable to access\n"),
    ]);

    globalThis.fetch = (async () => {
      return new Response(sideBandData, {
        status: 200,
        headers: { "content-type": "application/x-git-upload-pack-result" },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any as typeof globalThis.fetch;

    const client = createUploadPackHttpClient("http://dummy.example.com/repo");
    const raw = await client.request(Buffer.from("test body"));

    expect(() => decodeUploadPackResponse(raw)).toThrow(/unable to access/);

    globalThis.fetch = originalFetch;
  });

  test("正常的 side-band 响应不受影响", async () => {
    const originalFetch = globalThis.fetch;

    const packData = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0x00, 0x00, 0x00, 0x02]);
    const sideBandData = Buffer.concat([
      sideBandFrame(1, packData),
      sideBandFrame(2, "progress: done\n"),
    ]);

    globalThis.fetch = (async () => {
      return new Response(sideBandData, {
        status: 200,
        headers: { "content-type": "application/x-git-upload-pack-result" },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any as typeof globalThis.fetch;

    const client = createUploadPackHttpClient("http://dummy.example.com/repo");
    const raw = await client.request(Buffer.from("test body"));
    const result = decodeUploadPackResponse(raw);
    expect(result.packfile).toEqual(packData);
    expect(result.progress).toEqual(["progress: done\n"]);

    globalThis.fetch = originalFetch;
  });
});

// ============================================================================
// 协议错误传播测试
// ============================================================================

describe("decodeUploadPackResponse 协议错误", () => {
  test("非 side-band 但 pkt-line 截断时回退为空 packfile", async () => {
    const originalFetch = globalThis.fetch;

    const truncatedData = Buffer.concat([encodePktLine("NAK\n"), Buffer.from("000", "utf-8")]);

    globalThis.fetch = (async () => {
      return new Response(truncatedData, {
        status: 200,
        headers: { "content-type": "application/x-git-upload-pack-result" },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any as typeof globalThis.fetch;

    const client = createUploadPackHttpClient("http://dummy.example.com/repo");
    const raw = await client.request(Buffer.from("test body"));
    const result = decodeUploadPackResponse(raw);
    expect(result.packfile.length).toBe(0);

    globalThis.fetch = originalFetch;
  });

  test("非 side-band 合法 NAK+PACK 响应不受影响", async () => {
    const originalFetch = globalThis.fetch;

    const rawPack = Buffer.alloc(12);
    rawPack.write("PACK", 0, "utf-8");
    rawPack.writeUInt32BE(2, 4);
    rawPack.writeUInt32BE(0, 8);
    const data = Buffer.concat([encodePktLine("NAK\n"), rawPack]);

    globalThis.fetch = (async () => {
      return new Response(data, {
        status: 200,
        headers: { "content-type": "application/x-git-upload-pack-result" },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any as typeof globalThis.fetch;

    const client = createUploadPackHttpClient("http://dummy.example.com/repo");
    const raw = await client.request(Buffer.from("test body"));
    const result = decodeUploadPackResponse(raw);
    expect(result.packfile.length).toBeGreaterThan(0);
    expect(result.packfile.toString("utf-8").startsWith("PACK")).toBe(true);

    globalThis.fetch = originalFetch;
  });
});
