/**
 * Upload-Pack 直接调用测试
 *
 * 验证直接调用 postUploadPack 接口能正确获取 packfile。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import { createTempDir, cleanupDir } from "../helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";

import { createSmartHttpClient } from "../../../src/transport/smart-http.ts";
import { createServerRepo } from "./helpers.ts";

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

  test("postUploadPack 返回正确 packfile", async () => {
    const transport = createSmartHttpClient(serverUrl);
    const adv = await transport.getRefAdvertisement();
    const mainRef = adv.refs.find((r) => r.name === "refs/heads/main");
    expect(mainRef).toBeDefined();

    const { buildUploadPackRequest } = await import("../../../src/transport/negotiate.ts");
    const caps = ["multi_ack", "side-band-64k", "ofs-delta"];
    const body = buildUploadPackRequest([mainRef!.hash], [], caps);

    const result = await transport.postUploadPack(body);
    expect(result.packfile.length).toBeGreaterThan(0);
    expect(result.packfile.subarray(0, 4).toString("utf-8")).toBe("PACK");
  });
});
