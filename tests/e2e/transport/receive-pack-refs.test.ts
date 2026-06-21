/**
 * Receive-Pack Ref 测试
 *
 * 验证通过 smart HTTP 协议获取 receive-pack ref advertisement 的完整流程。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";

import { git, gitInit, createTempDir, cleanupDir, createFile } from "../helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";

import { sha1 } from "../../../src/core/types.ts";
import { createSmartHttpClient } from "../../../src/transport/smart-http.ts";
import { createServerRepo } from "./helpers.ts";

describe("receive-pack ref advertisement", () => {
  let tempDir: string;
  let repoDir: string;
  let serverUrl: string;
  let commitHash: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-http-receive-pack");
    const created = createServerRepo(tempDir, "test.git", true);
    repoDir = created.repoDir;
    commitHash = created.commitHash;
    server = startGitHttpBackendServer(tempDir, "/test.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("解析 receive-pack ref advertisement", async () => {
    const transport = createSmartHttpClient(serverUrl);
    const adv = await transport.getReceivePackRefs();

    expect(adv.refs.length).toBeGreaterThanOrEqual(1);

    const mainRef = adv.refs.find((r) => r.name === "refs/heads/main");
    expect(mainRef).toBeDefined();
    expect(mainRef!.hash).toBe(sha1(commitHash));

    expect(adv.capabilities["report-status"]).toBe(true);
    expect(adv.capabilities["side-band-64k"]).toBe(true);
    expect(adv.capabilities["ofs-delta"]).toBe(true);
    expect(adv.capabilities["delete-refs"]).toBe(true);
  });

  test("解析带多个分支的 receive-pack ref advertisement", async () => {
    const branchDir = join(tempDir, "branch-work");
    gitInit(branchDir);
    createFile(branchDir, "feature.md", "# Feature\n");
    git(["add", "feature.md"], branchDir);
    git(["commit", "-m", "Feature commit"], branchDir);
    git(["push", repoDir, "HEAD:refs/heads/feature"], branchDir);

    const transport = createSmartHttpClient(serverUrl);
    const adv = await transport.getReceivePackRefs();

    const featureRef = adv.refs.find((r) => r.name === "refs/heads/feature");
    expect(featureRef).toBeDefined();
  });
});
