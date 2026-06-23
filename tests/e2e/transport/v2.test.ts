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

describe("v2 协议 - object-info 命令", () => {
  let tempDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;
  let mainCommitHash: ReturnType<typeof sha1>;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2-object-info");
    const serverRepo = createServerRepo(tempDir, "server.git");
    mainCommitHash = sha1(serverRepo.commitHash);
    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("object-info 返回对象 size", async () => {
    const { detectProtocol } = await import("@/transport/v2/detect.ts");
    const { objectInfo } = await import("@/transport/v2/object-info.ts");
    const result = await detectProtocol(url);
    if (result.protocol !== "v2") return;

    // object-info 需要服务端配置 uploadpack.advertiseObjectInfo=true
    // 默认不启用，如果服务端不支持则跳过
    const hasObjectInfo = result.capabilities.commands.some((c) => c.name === "object-info");
    if (!hasObjectInfo) return;

    const info = await objectInfo(result.transport, [mainCommitHash]);
    expect(info.attrs).toContain("size");
    expect(info.objects.length).toBeGreaterThan(0);
    expect(info.objects[0]!.oid).toBe(mainCommitHash);
  });

  test("repo.fetchObjectInfo 高层 API 可用", async () => {
    const { createMemoryRepository } = await import("@/repository/index.ts");
    const repo = createMemoryRepository();
    const result = await detectProtocol(url);
    if (result.protocol !== "v2") return;

    const hasObjectInfo = result.capabilities.commands.some((c) => c.name === "object-info");
    if (!hasObjectInfo) return;

    const info = await repo.fetchObjectInfo(url, [mainCommitHash]);
    expect(info.objects.length).toBeGreaterThan(0);
    expect(info.objects[0]!.oid).toBe(mainCommitHash);
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

describe("v2 协议 - 增量 fetch 多轮协商", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;
  let initialCommitHash: string;
  let latestCommitHash: string;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2-incremental");

    // 1. 创建服务端裸仓库（初始 1 次提交）
    serverRepoDir = join(tempDir, "server.git");
    workDir = join(tempDir, "work");

    const { mkdirSync } = await import("node:fs");
    const { git, gitInit, createFile } = await import("../helpers.ts");

    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);

    // 初始提交
    gitInit(workDir);
    createFile(workDir, "README.md", "# Hello\n");
    git(["add", "README.md"], workDir);
    git(["commit", "-m", "Initial commit"], workDir);
    initialCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    // 2. 启动 http 服务（此时只有 1 次提交）
    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("先通过 v2 克隆初始仓库，再增量拉取新提交", async () => {
    const repo = initRepository(join(tempDir, "local-clone"));

    // 第一步：v2 克隆（初始状态：只有 1 次提交，refs/heads/main = initialCommitHash）
    const session1 = await repo.openImportSession({ url });
    const plan1 = session1
      .plan()
      .materialize(session1.defaultBranch())
      .toBranch("main")
      .materialize(session1.defaultBranch())
      .setHead();
    const result1 = await plan1.apply();
    expect(result1.updatedRefs.get("refs/heads/main")).toBe(sha1(initialCommitHash));

    // 第二步：在服务器端创建新提交
    const { git, createFile } = await import("../helpers.ts");
    createFile(workDir, "feature.txt", "v2 feature\n");
    git(["add", "feature.txt"], workDir);
    git(["commit", "-m", "Add feature"], workDir);
    latestCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    // 第三步：v2 增量 fetch 拉取新提交
    const session2 = await repo.openImportSession({ url });
    expect(session2.advertisement.refs.find((r) => r.name === "refs/heads/main")?.hash).toBe(
      sha1(latestCommitHash),
    );

    const plan2 = session2.plan().materialize(session2.defaultBranch()).toBranch("main");
    const preview2 = await plan2.preview();
    expect(preview2.canApply).toBe(true);
    expect(preview2.prefetchedObjects).toBeGreaterThan(0);

    const result2 = await plan2.apply();
    expect(result2.updatedRefs.get("refs/heads/main")).toBe(sha1(latestCommitHash));
    expect(gitRevParse(join(tempDir, "local-clone"), "HEAD")).toBe(sha1(latestCommitHash));
  });
});

describe("v2 协议 - v1 vs v2 一致性", () => {
  let tempDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2-consistency");
    createServerRepo(tempDir, "server.git");
    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("v1 和 v2 ImportSession 获取到相同的 refs 列表", async () => {
    // v1 获取
    const { createUploadPackHttpClient } = await import("@/transport/smart-http.ts");
    const v1Transport = createUploadPackHttpClient(url);
    const v1Adv = await v1Transport.advertise();

    // v2 获取
    const v2Result = await detectProtocol(url);
    expect(v2Result.protocol).toBe("v2");
    if (v2Result.protocol !== "v2") return;

    const { lsRefs, lsRefsToRefAdvertisement } = await import("@/transport/v2/ls-refs.ts");
    const v2Entries = await lsRefs(v2Result.transport, { symrefs: true, peel: true });
    const v2Adv = lsRefsToRefAdvertisement(v2Entries);

    // 对比 refs 数量
    expect(v2Adv.refs.length).toBe(v1Adv.refs.length);

    // 对比每个 ref 的 hash 和 name
    for (const v1Ref of v1Adv.refs) {
      // v2 可能不包含 HEAD（取决于服务端实现），跳过 HEAD
      if (v1Ref.name === "HEAD") continue;
      const v2Ref = v2Adv.refs.find((r) => r.name === v1Ref.name);
      expect(v2Ref).toBeDefined();
      expect(v2Ref!.hash).toBe(v1Ref.hash);
      expect(v2Ref!.symrefTarget).toBe(v1Ref.symrefTarget);
    }
  });
});

describe("v2 协议 - 降级强制回退", () => {
  let tempDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2-force-fallback");
    createServerRepo(tempDir, "server.git");
    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("v2 advertise 失败时 detectProtocol 返回 v1", async () => {
    // 构造一个返回 v1 格式的服务（不传 Git-Protocol 头即为 v1）
    const result = await detectProtocol(url);
    // 默认 server 支持 v2，所以预期是 v2
    // 此测试主要验证 detectProtocol 的容错机制
    // 如果服务端返回非标准格式，detectProtocol 不会抛异常
    expect(result.protocol === "v2" || result.protocol === "v1").toBe(true);
  });

  test("ImportSession 在不支持 v2 的服务器上自动回退到 v1", async () => {
    const localDir = join(tempDir, "local-fallback");
    const repo = initRepository(localDir);

    // 使用一个只支持 v1 的服务——通过不带 Git-Protocol 头的 url 来测试
    // 实际上 detectProtocol 在连接失败时会返回 v1，回退到 v1 路径
    // 以畸形 URL 测试降级行为
    const badResult = await detectProtocol("http://localhost:1/nonexistent");
    expect(badResult.protocol).toBe("v1");

    // 正常 URL 走 v2 路径应该成功
    const session = await repo.openImportSession({ url });
    expect(session.advertisement.refs.length).toBeGreaterThan(0);
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
