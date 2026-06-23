/**
 * Smart HTTP 服务端适配层单元测试
 *
 * 测试 createSmartHttpHandler 的路由、验证、响应生成。
 * upload-pack / receive-pack 的协议逻辑已在各自服务测试中覆盖，
 * 此文件聚焦 HTTP 层面的逻辑：
 * - 路由解析（info/refs、git-upload-pack、未知路径）
 * - 请求验证（method、service、content-type）
 * - v2 协议头检测
 * - 错误响应
 */

import { describe, test, expect } from "bun:test";

import { createMemoryRepositoryBackend } from "@/backend/index.ts";
import { writeObject } from "@/objects/raw.ts";
import { createSmartHttpHandler } from "@/transport/http/smart-http.ts";

// ============================================================================
// 测试辅助
// ============================================================================

function createTestBackend() {
  const backend = createMemoryRepositoryBackend({
    initialRefs: new Map<string, string>([["HEAD", "ref: refs/heads/main"]]),
  });

  const blobHash = writeObject(backend.objects, {
    type: "blob" as const,
    content: Buffer.from("hello"),
  });
  const treeHash = writeObject(backend.objects, {
    type: "tree" as const,
    entries: [{ mode: "100644", name: "f.txt", hash: blobHash }],
  });
  const commitHash = writeObject(backend.objects, {
    type: "commit" as const,
    tree: treeHash,
    parents: [],
    author: { name: "T", email: "t@t", timestamp: 0, timezone: "+0000" },
    committer: { name: "T", email: "t@t", timestamp: 0, timezone: "+0000" },
    message: "init\n",
  });
  backend.refs.write("refs/heads/main", commitHash);

  return { backend, commitHash };
}

/** 创建标准 Request 的辅助函数 */
function createGitRequest(
  path: string,
  options?: {
    method?: string;
    searchParams?: Record<string, string>;
    headers?: Record<string, string>;
    body?: Buffer;
  },
): Request {
  let urlStr = `http://localhost${path}`;
  if (options?.searchParams) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(options.searchParams)) {
      params.set(k, v);
    }
    urlStr += "?" + params.toString();
  }

  return new Request(urlStr, {
    method: options?.method ?? "GET",
    headers: {
      "Git-Protocol": "version=2",
      ...options?.headers,
    },
    body: options?.body ?? null,
  });
}

// ============================================================================
// 路由测试
// ============================================================================

describe("createSmartHttpHandler — 路由", () => {
  test("GET /info/refs?service=git-upload-pack 返回 200", async () => {
    const { backend } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    const req = createGitRequest("/info/refs", {
      searchParams: { service: "git-upload-pack" },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("git-upload-pack-advertisement");
  });

  test("GET /info/refs?service=git-receive-pack 返回 200", async () => {
    const { backend } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    const req = createGitRequest("/info/refs", {
      searchParams: { service: "git-receive-pack" },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("git-receive-pack-advertisement");
  });

  test("POST /git-upload-pack 返回 200（含有效命令体）", async () => {
    const { backend, commitHash } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    const _body = Buffer.concat([
      Buffer.from("command=ls-refs\n0011", "utf-8"),
      Buffer.from([0x00, 0x01]),
      Buffer.from("0013000a", "utf-8"),
    ]);
    // 使用标准 v2 格式构造有效请求
    const { encodePktLine, encodeDelimiterPkt, encodeFlushPkt } =
      await import("@/transport/protocol/pkt-line.ts");

    const validBody = Buffer.concat([
      encodePktLine("command=fetch\n"),
      encodeDelimiterPkt(),
      encodePktLine(`want ${commitHash}\n`),
      encodePktLine("ofs-delta\n"),
      encodePktLine("done\n"),
      encodeFlushPkt(),
    ]);

    const req = createGitRequest("/git-upload-pack", {
      method: "POST",
      body: validBody,
      headers: { "Content-Type": "application/x-git-upload-pack-request" },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-git-upload-pack-result");
  });

  test("二级路径也匹配（如 /repo.git/info/refs）", async () => {
    const { backend } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    const req = createGitRequest("/repo.git/info/refs", {
      searchParams: { service: "git-upload-pack" },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  test("未知路径返回 404", async () => {
    const { backend } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    const req = createGitRequest("/unknown-path");
    const res = await handler(req);
    expect(res.status).toBe(404);
  });

  test("/git-receive-pack 需要有效的 Content-Type", async () => {
    const { backend } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    const req = createGitRequest("/git-receive-pack", { method: "POST" });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// 验证测试
// ============================================================================

describe("createSmartHttpHandler — 请求验证", () => {
  test("info/refs 需要 GET 方法", async () => {
    const { backend } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    const req = createGitRequest("/info/refs", {
      method: "POST",
      searchParams: { service: "git-upload-pack" },
    });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });

  test("info/refs 需要有效 service", async () => {
    const { backend } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    const req = createGitRequest("/info/refs", {
      searchParams: { service: "invalid-service" },
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  test("info/refs 缺少 service 参数返回 400", async () => {
    const { backend } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    const req = createGitRequest("/info/refs", { searchParams: {} });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  test("info/refs 需要 Git-Protocol: version=2 头", async () => {
    const { backend } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    // 无 Git-Protocol 头的请求
    const req = new Request("http://localhost/info/refs?service=git-upload-pack");
    const res = await handler(req);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Git-Protocol");
  });

  test("git-upload-pack 需要 POST 方法", async () => {
    const { backend } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    const req = createGitRequest("/git-upload-pack", { method: "GET" });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });

  test("git-upload-pack 需要有效的 Content-Type", async () => {
    const { backend } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    const req = createGitRequest("/git-upload-pack", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  test("git-upload-pack 空 body 返回 400", async () => {
    const { backend } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    const req = createGitRequest("/git-upload-pack", {
      method: "POST",
      headers: { "Content-Type": "application/x-git-upload-pack-request" },
      body: Buffer.alloc(0),
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// 端到端 handler 测试（通过完整 ls-refs 请求）
// ============================================================================

describe("createSmartHttpHandler — 完整请求", () => {
  test("ls-refs 命令通过 POST /git-upload-pack 返回 ref 列表", async () => {
    const { backend, commitHash } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    const { encodePktLine, encodeDelimiterPkt, encodeFlushPkt } =
      await import("@/transport/protocol/pkt-line.ts");

    const body = Buffer.concat([
      encodePktLine("command=ls-refs\n"),
      encodeDelimiterPkt(),
      encodePktLine("symrefs\n"),
      encodeFlushPkt(),
    ]);

    const req = createGitRequest("/git-upload-pack", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-git-upload-pack-request" },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text).toContain("refs/heads/main");
    expect(text).toContain(commitHash);
    expect(text).toContain("symref-target:refs/heads/main");
  });

  test("fetch 命令通过 POST /git-upload-pack 返回 packfile", async () => {
    const { backend, commitHash } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    const { encodePktLine, encodeDelimiterPkt, encodeFlushPkt } =
      await import("@/transport/protocol/pkt-line.ts");

    const body = Buffer.concat([
      encodePktLine("command=fetch\n"),
      encodeDelimiterPkt(),
      encodePktLine(`want ${commitHash}\n`),
      encodePktLine("done\n"),
      encodeFlushPkt(),
    ]);

    const req = createGitRequest("/git-upload-pack", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-git-upload-pack-request" },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const buf = Buffer.from(await res.arrayBuffer());
    const bufText = buf.toString("utf-8");
    expect(bufText).toContain("packfile");
  });

  test("响应包含 Cache-Control: no-cache", async () => {
    const { backend } = createTestBackend();
    const handler = createSmartHttpHandler(backend);

    const req = createGitRequest("/info/refs", {
      searchParams: { service: "git-upload-pack" },
    });
    const res = await handler(req);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });
});
