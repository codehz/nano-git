/**
 * Upload-Pack 直接调用测试
 *
 * 验证 transport.request + decodeUploadPackResponse 能正确获取 packfile。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import { createTempDir, cleanupDir } from "../helpers.ts";
import { createServerRepo } from "./helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { createUploadPackHttpClient } from "@/transport/smart-http.ts";
import { decodeUploadPackResponse } from "@/transport/upload-pack-response.ts";

describe("upload-pack 直接调用", () => {
  let tempDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-http-upload-pack-direct");
    createServerRepo(tempDir, "test.git");
    server = startGitHttpBackendServer(tempDir, "/test.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("request 返回的 body 解码后含正确 packfile", async () => {
    const transport = createUploadPackHttpClient(serverUrl);
    const adv = await transport.advertise();
    const mainRef = adv.refs.find((r) => r.name === "refs/heads/main");
    expect(mainRef).toBeDefined();

    const { buildUploadPackRequest } = await import("../../../src/transport/negotiate.ts");
    const caps = ["multi_ack", "side-band-64k", "ofs-delta"];
    const body = buildUploadPackRequest([mainRef!.hash], [], caps);

    const raw = await transport.request(body);
    const result = decodeUploadPackResponse(raw);
    expect(result.packfile.length).toBeGreaterThan(0);
    expect(result.packfile.subarray(0, 4).toString("utf-8")).toBe("PACK");
  });
});
