/**
 * v2 协议端到端测试
 *
 * 通过真实 git-http-backend 验证 Git Wire 协议 v2 支持：
 * - 协议检测（v2 可用时正确识别）
 * - ls-refs 命令
 * - v2 fetch 命令
 * - v2 ImportSession 透明升级
 * - v1 回退（不使用 Git-Protocol 头时）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";

import { cleanupDir, createTempDir, gitRevParse } from "../helpers.ts";
import { createServerRepo } from "./helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { sha1 } from "@/core/types.ts";
import { initRepository } from "@/repository/index.ts";
import { detectProtocol } from "@/transport/v2/detect.ts";
import { v2Fetch } from "@/transport/v2/fetch.ts";
import { lsRefs, lsRefsToRefAdvertisement } from "@/transport/v2/ls-refs.ts";

describe("v2 协议 - 服务器能力", () => {
  let tempDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;
  let mainCommitHash: ReturnType<typeof sha1>;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2");
    const serverRepo = createServerRepo(tempDir, "server.git");
    mainCommitHash = sha1(serverRepo.commitHash);
    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("detectProtocol 检测到 v2 能力广告", async () => {
    const result = await detectProtocol(url);

    expect(result.protocol).toBe("v2");
    if (result.protocol === "v2") {
      // 验证能力广告
      expect(result.capabilities.commands.length).toBeGreaterThan(0);
      const commandNames = result.capabilities.commands.map((c) => c.name);
      expect(commandNames).toContain("ls-refs");
      expect(commandNames).toContain("fetch");
      expect(result.capabilities.capabilities["version"]).toBeUndefined();
    }
  });

  test("ls-refs 返回远程 ref 列表", async () => {
    const result = await detectProtocol(url);
    expect(result.protocol).toBe("v2");
    if (result.protocol !== "v2") return;

    const entries = await lsRefs(result.transport, {
      symrefs: true,
      peel: true,
      // 不指定 refPrefixes，获取所有 refs
    });

    // 应包含 refs/heads/main（通过 createServerRepo 创建）
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const mainEntry = entries.find((e) => e.refname === "refs/heads/main");
    expect(mainEntry).toBeDefined();
    expect(mainEntry!.oid).toBe(mainCommitHash);
  });

  test("ls-refs ref-prefix 过滤生效", async () => {
    const result = await detectProtocol(url);
    expect(result.protocol).toBe("v2");
    if (result.protocol !== "v2") return;

    // 只请求 heads 前缀
    const headsEntries = await lsRefs(result.transport, {
      refPrefixes: ["refs/heads/"],
    });

    // HEAD 可能因为服务端实现也被返回（v2 规范说 ref-prefix 只是优化）
    for (const entry of headsEntries) {
      expect(entry.refname === "HEAD" || entry.refname.startsWith("refs/heads/")).toBe(true);
    }
  });

  test("ls-refs 可转换为 v1 RefAdvertisement", async () => {
    const result = await detectProtocol(url);
    expect(result.protocol).toBe("v2");
    if (result.protocol !== "v2") return;

    const entries = await lsRefs(result.transport, {
      symrefs: true,
      peel: true,
    });

    const adv = lsRefsToRefAdvertisement(entries);
    expect(adv.refs.length).toBeGreaterThan(0);
    expect(adv.defaultBranch).toBe("refs/heads/main");
  });
});

describe("v2 协议 - fetch 命令", () => {
  let tempDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;
  let mainCommitHash: ReturnType<typeof sha1>;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2-fetch");
    const serverRepo = createServerRepo(tempDir, "server.git");
    mainCommitHash = sha1(serverRepo.commitHash);
    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("v2 fetch 发送 want + done 接收 packfile", async () => {
    const result = await detectProtocol(url);
    expect(result.protocol).toBe("v2");
    if (result.protocol !== "v2") return;

    // 获取服务端 fetch 命令的特性支持
    const fetchCmd = result.capabilities.commands.find((c) => c.name === "fetch");
    const features = fetchCmd?.features;

    const fetchResult = await v2Fetch(
      result.transport,
      { wants: [mainCommitHash], ofsDelta: true, done: true },
      features,
    );

    expect(fetchResult.packfile).toBeDefined();
    expect(fetchResult.packfile!.length).toBeGreaterThan(40);
    // packfile 以 "PACK" 开头
    expect(fetchResult.packfile!.subarray(0, 4).toString("utf-8")).toBe("PACK");
  });

  test("v2 fetch 没有 want 时应在 v2Fetch 内部抛出错误", async () => {
    const result = await detectProtocol(url);
    expect(result.protocol).toBe("v2");
    if (result.protocol !== "v2") return;

    expect(v2Fetch(result.transport, { wants: [], ofsDelta: true })).rejects.toBeInstanceOf(Error);
  });
});

describe("v2 协议 - ImportSession 透明升级", () => {
  let tempDir: string;
  let localDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;
  let mainCommitHash: ReturnType<typeof sha1>;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2-import");
    localDir = join(tempDir, "local");
    const serverRepo = createServerRepo(tempDir, "server.git");
    mainCommitHash = sha1(serverRepo.commitHash);
    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("ImportSession 通过 v2 协议导入对象和 ref", async () => {
    const repo = initRepository(localDir);
    const session = await repo.openImportSession({ url });

    // 验证 session 中 refs 正确
    expect(session.advertisement.refs.length).toBeGreaterThan(0);
    const mainRef = session.advertisement.refs.find((r) => r.name === "refs/heads/main");
    expect(mainRef).toBeDefined();
    expect(mainRef!.hash).toBe(mainCommitHash);

    // 执行物化
    const defaultBranch = session.defaultBranch();
    const plan = session
      .plan()
      .materialize(defaultBranch)
      .toBranch("main")
      .materialize(defaultBranch)
      .setHead();

    const preview = await plan.preview();
    expect(preview.canApply).toBe(true);

    const result = await plan.apply();
    expect(result.updatedRefs.get("refs/heads/main")).toBe(mainCommitHash);
    expect(result.importedObjects).toBe(preview.prefetchedObjects);

    // 验证对象完整性
    const headHash = gitRevParse(localDir, "HEAD");
    expect(headHash).toBe(mainCommitHash);
  });
});

describe("v2 协议 - v1 回退", () => {
  let tempDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2-fallback");
    createServerRepo(tempDir, "server.git");
    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("不使用 Git-Protocol 头时使用 v1 协议", async () => {
    // 直接使用 v1 transport，不调用 detectProtocol
    const { createUploadPackHttpClient } = await import("@/transport/smart-http.ts");
    const transport = createUploadPackHttpClient(url);
    const adv = await transport.advertise();

    // v1 advertisement 应包含 capabilities
    expect(adv.refs.length).toBeGreaterThan(0);
    expect(adv.capabilities).toHaveProperty("multi_ack");
    expect(adv.capabilities).toHaveProperty("side-band-64k");
  });
});
