/**
 * Ref Advertisement 测试
 *
 * 验证通过 smart HTTP 协议获取 ref advertisement 的完整流程。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { git, gitInit, createTempDir, cleanupDir, createFile } from "../helpers.ts";
import { createServerRepo } from "./helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { sha1 } from "@/core/types.ts";
import { createSmartHttpClient } from "@/transport/smart-http.ts";

describe("ref advertisement", () => {
  let tempDir: string;
  let repoDir: string;
  let serverUrl: string;
  let commitHash: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-http-refs");
    const created = createServerRepo(tempDir, "test.git");
    repoDir = created.repoDir;
    commitHash = created.commitHash;
    server = startGitHttpBackendServer(tempDir, "/test.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("解析 ref advertisement 并验证 refs", async () => {
    const transport = createSmartHttpClient(serverUrl);
    const adv = await transport.getRefAdvertisement();

    expect(adv.refs.length).toBeGreaterThanOrEqual(1);

    const mainRef = adv.refs.find((r) => r.name === "refs/heads/main");
    expect(mainRef).toBeDefined();
    expect(mainRef!.hash).toBe(sha1(commitHash));

    expect(adv.capabilities["multi_ack"]).toBe(true);
    expect(adv.capabilities["side-band-64k"]).toBe(true);
    expect(adv.capabilities["ofs-delta"]).toBe(true);
    expect(adv.capabilities["agent"]).toMatch(/^git\//);
  });

  test("解析带多个分支的 ref advertisement", async () => {
    const branchDir = join(tempDir, "branch-work");
    gitInit(branchDir);
    createFile(branchDir, "feature.md", "# Feature\n");
    git(["add", "feature.md"], branchDir);
    git(["commit", "-m", "Feature commit"], branchDir);
    git(["push", repoDir, "HEAD:refs/heads/feature"], branchDir);

    const transport = createSmartHttpClient(serverUrl);
    const adv = await transport.getRefAdvertisement();

    const featureRef = adv.refs.find((r) => r.name === "refs/heads/feature");
    expect(featureRef).toBeDefined();
  });

  test("空仓库应返回 capabilities 但无 refs", async () => {
    const emptyDir = join(tempDir, "empty.git");
    mkdirSync(emptyDir);
    git(["init", "--bare"], emptyDir);

    const emptyServer = startGitHttpBackendServer(tempDir, "/empty.git");
    try {
      const transport = createSmartHttpClient(emptyServer.url);
      const adv = await transport.getRefAdvertisement();

      expect(adv.refs).toHaveLength(0);
      expect(Object.keys(adv.capabilities).length).toBeGreaterThan(0);
    } finally {
      await emptyServer.stop();
    }
  });
});
