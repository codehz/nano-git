/**
 * v2 协议端到端测试
 *
 * 通过真实 git-http-backend 验证 Git Wire 协议 v2 支持：
 * - 能力广告
 * - ls-refs 命令
 * - v2 fetch 命令
 * - v2 ImportSession 透明升级
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  cleanupDir,
  createTempDir,
  gitRevParse,
  git,
  gitInit,
  createFile,
  gitWithTimeout,
} from "../helpers.ts";
import {
  createServerRepo,
  decodeUploadPackCommands,
  getNormalizedFetchCommandBatches,
  getUploadPackRequests,
} from "./helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { createHttpRemote } from "@/remote/http.ts";
import { initRepository } from "@/repository/file.ts";
import { parseV2FetchResponse, v2Fetch } from "@/transport/client/upload-pack/fetch.ts";
import { createV2HttpTransport } from "@/transport/client/upload-pack/http.ts";
import { lsRefs, lsRefsToRefAdvertisement } from "@/transport/client/upload-pack/ls-refs.ts";
import { objectInfo } from "@/transport/client/upload-pack/object-info.ts";
import {
  encodeDelimiterPkt,
  encodeFlushPkt,
  encodePktLine,
} from "@/transport/protocol/pkt-line.ts";
import { sha1 } from "@/types/index.ts";

import type { ImportPlanDraft } from "@/repository/import/import-session-types.ts";

async function prepareDraft(draft: ImportPlanDraft) {
  return draft.build().prepare();
}

async function previewDraft(draft: ImportPlanDraft) {
  return (await prepareDraft(draft)).preview;
}

async function applyDraft(draft: ImportPlanDraft) {
  return (await prepareDraft(draft)).apply();
}

async function cloneNanoHeads(url: string, localDir: string) {
  const repo = initRepository(localDir);
  const session = await repo.openImportSession({ url });
  const plan = session
    .plan()
    .materialize(session.select("refs/heads/*"))
    .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } })
    .materialize(session.defaultBranch())
    .setHead();
  await applyDraft(plan);
  return repo;
}

async function cloneNanoHeadsAndTags(url: string, localDir: string) {
  const repo = initRepository(localDir);
  const session = await repo.openImportSession({ url });
  const plan = session
    .plan()
    .materialize(session.select("refs/heads/*"))
    .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } })
    .materialize(session.select("refs/tags/*"))
    .toNamespace("refs/tags/*", { policy: { mode: "create-only" } })
    .materialize(session.defaultBranch())
    .setHead();
  await applyDraft(plan);
  return repo;
}

async function fetchNanoHeads(repo: ReturnType<typeof initRepository>, url: string) {
  const session = await repo.openImportSession({ url });
  const plan = session
    .plan()
    .materialize(session.select("refs/heads/*"))
    .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } });
  return previewDraft(plan);
}

async function fetchNanoHeadsAndTags(repo: ReturnType<typeof initRepository>, url: string) {
  const session = await repo.openImportSession({ url });
  const plan = session
    .plan()
    .materialize(session.select("refs/heads/*"))
    .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } })
    .materialize(session.select("refs/tags/*"))
    .toNamespace("refs/tags/*", { policy: { mode: "create-only" } });
  return previewDraft(plan);
}

async function cloneGitCli(url: string, localDir: string, tempDir: string) {
  await gitWithTimeout(["-c", "protocol.version=2", "clone", url, localDir], tempDir, 15000);
  await gitWithTimeout(
    ["-c", "protocol.version=2", "fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"],
    localDir,
    15000,
  );
}

async function fetchGitCli(localDir: string, options: { readonly tags?: boolean } = {}) {
  const args = ["-c", "protocol.version=2", "fetch"];
  if (options.tags) {
    args.push("--tags");
  }
  args.push("origin");
  await gitWithTimeout(args, localDir, 15000);
}

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

  test("能力广告包含 v2 命令", async () => {
    const transport = createV2HttpTransport(url);
    const caps = await transport.advertise();

    expect(caps.commands.length).toBeGreaterThan(0);
    const commandNames = caps.commands.map((c) => c.name);
    expect(commandNames).toContain("ls-refs");
    expect(commandNames).toContain("fetch");
  });

  test("ls-refs 返回远程 ref 列表", async () => {
    const transport = createV2HttpTransport(url);

    const entries = await lsRefs(transport, {
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
    const transport = createV2HttpTransport(url);

    // 只请求 heads 前缀
    const headsEntries = await lsRefs(transport, {
      refPrefixes: ["refs/heads/"],
    });

    // HEAD 可能因为服务端实现也被返回（v2 规范说 ref-prefix 只是优化）
    for (const entry of headsEntries) {
      expect(entry.refname === "HEAD" || entry.refname.startsWith("refs/heads/")).toBe(true);
    }
  });

  test("ls-refs 可转换为 v1 RefAdvertisement", async () => {
    const transport = createV2HttpTransport(url);

    const entries = await lsRefs(transport, {
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
    const transport = createV2HttpTransport(url);
    const caps = await transport.advertise();

    // object-info 需要服务端配置 uploadpack.advertiseObjectInfo=true
    // 默认不启用，如果服务端不支持则跳过
    const hasObjectInfo = caps.commands.some((c) => c.name === "object-info");
    if (!hasObjectInfo) return;

    const info = await objectInfo(transport, [mainCommitHash]);
    expect(info.attrs).toContain("size");
    expect(info.objects.length).toBeGreaterThan(0);
    expect(info.objects[0]!.oid).toBe(mainCommitHash);
  });

  test("remote/http 高层 API 可用", async () => {
    const transport = createV2HttpTransport(url);
    const caps = await transport.advertise();
    const hasObjectInfo = caps.commands.some((c) => c.name === "object-info");
    if (!hasObjectInfo) return;

    const remote = createHttpRemote({ url });
    const snapshot = await remote.readRefAdvertisement();
    const info = await remote.fetchObjectInfo([mainCommitHash]);
    expect(snapshot.defaultBranch).toBe("refs/heads/main");
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
    const transport = createV2HttpTransport(url);
    const caps = await transport.advertise();

    // 获取服务端 fetch 命令的特性支持
    const fetchCmd = caps.commands.find((c) => c.name === "fetch");
    const features = fetchCmd?.features;

    const fetchResult = await v2Fetch(
      transport,
      { wants: [mainCommitHash], ofsDelta: true, done: true },
      features,
    );

    expect(fetchResult.packfile).toBeDefined();
    expect(fetchResult.packfile!.length).toBeGreaterThan(40);
    // packfile 以 "PACK" 开头
    expect(fetchResult.packfile!.subarray(0, 4).toString("utf-8")).toBe("PACK");
  });

  test("v2 fetch 没有 want 时应在 v2Fetch 内部抛出错误", async () => {
    const transport = createV2HttpTransport(url);

    expect(v2Fetch(transport, { wants: [], ofsDelta: true })).rejects.toBeInstanceOf(Error);
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

    const prepared = await prepareDraft(plan);
    const preview = prepared.preview;
    expect(preview.canApply).toBe(true);

    const result = await prepared.apply();
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
    const result1 = await applyDraft(plan1);
    expect(result1.updatedRefs.get("refs/heads/main")).toBe(sha1(initialCommitHash));

    // 第二步：在服务器端创建新提交
    createFile(workDir, "feature.txt", "v2 feature\n");
    git(["add", "feature.txt"], workDir);
    git(["commit", "-m", "Add feature"], workDir);
    latestCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);
    server.clearRequests();

    // 第三步：v2 增量 fetch 拉取新提交
    const session2 = await repo.openImportSession({ url });
    expect(session2.advertisement.refs.find((r) => r.name === "refs/heads/main")?.hash).toBe(
      sha1(latestCommitHash),
    );

    const plan2 = session2.plan().materialize(session2.defaultBranch()).toBranch("main");
    const preview2 = await previewDraft(plan2);
    expect(preview2.canApply).toBe(true);
    expect(preview2.prefetchedObjects).toBeGreaterThan(0);

    const uploadPackRequests = getUploadPackRequests(server.requests);
    expect(uploadPackRequests.length).toBeGreaterThan(0);
    const lsRefsRequest = uploadPackRequests.find((request) =>
      decodeUploadPackCommands(request.body).includes("command=ls-refs"),
    );
    const fetchRequest = uploadPackRequests.find((request) =>
      decodeUploadPackCommands(request.body).includes("command=fetch"),
    );
    expect(lsRefsRequest).toBeDefined();
    expect(fetchRequest).toBeDefined();
    const lsRefsCommands = decodeUploadPackCommands(lsRefsRequest!.body);
    expect(lsRefsCommands).toContain("object-format=sha1");
    expect(lsRefsCommands).toContain("unborn");
    expect(lsRefsCommands).toContain("ref-prefix refs/heads/main");
    const commands = decodeUploadPackCommands(fetchRequest!.body);
    expect(commands).toContain("agent=nano-git/0.1");
    expect(commands).toContain("object-format=sha1");
    expect(commands).toContain("thin-pack");
    expect(commands).toContain("no-progress");
    expect(commands).toContain("include-tag");
    expect(commands).toContain("ofs-delta");
    expect(commands).toContain(`want ${latestCommitHash}`);
    expect(commands).toContain(`have ${initialCommitHash}`);
    expect(commands).not.toContain("sideband-all");
    expect(commands).not.toContain("wait-for-done");

    const result2 = await applyDraft(plan2);
    expect(result2.updatedRefs.get("refs/heads/main")).toBe(sha1(latestCommitHash));
    expect(gitRevParse(join(tempDir, "local-clone"), "HEAD")).toBe(sha1(latestCommitHash));
  });
});

describe("v2 协议 - thin-pack 增量导入", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;
  let featureCommitHash: string;
  let mainCommitHash: string;
  let latestMainCommitHash: string;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2-thin-pack");
    serverRepoDir = join(tempDir, "server.git");
    workDir = join(tempDir, "work");

    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);

    gitInit(workDir);
    createFile(workDir, "README.md", "# Hello\n");
    git(["add", "README.md"], workDir);
    git(["commit", "-m", "A"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "-b", "feature"], workDir);
    createFile(workDir, "feature.txt", "feature\n");
    git(["add", "feature.txt"], workDir);
    git(["commit", "-m", "Feature"], workDir);
    featureCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "feature"], workDir);

    git(["checkout", "main"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    mainCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("多分支本地 refs 下可导入 git-http-backend 返回的 thin pack", async () => {
    const repo = initRepository(join(tempDir, "local-thin-pack"));

    const session1 = await repo.openImportSession({ url });
    const plan1 = session1
      .plan()
      .materialize(session1.select("refs/heads/*"))
      .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } })
      .materialize(session1.defaultBranch())
      .setHead();
    const result1 = await applyDraft(plan1);
    expect(result1.updatedRefs.get("refs/heads/main")).toBe(sha1(mainCommitHash));
    expect(result1.updatedRefs.get("refs/heads/feature")).toBe(sha1(featureCommitHash));

    createFile(workDir, "d.txt", "D\n");
    git(["add", "d.txt"], workDir);
    git(["commit", "-m", "D"], workDir);
    latestMainCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);
    server.clearRequests();

    const session2 = await repo.openImportSession({ url });
    const plan2 = session2
      .plan()
      .materialize(session2.select("refs/heads/*"))
      .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } });
    const preview2 = await previewDraft(plan2);
    expect(preview2.canApply).toBe(true);
    expect(preview2.prefetchedObjects).toBeGreaterThan(0);

    const fetchRequest = getUploadPackRequests(server.requests).find((request) =>
      decodeUploadPackCommands(request.body).includes("command=fetch"),
    );
    expect(fetchRequest).toBeDefined();
    const commands = decodeUploadPackCommands(fetchRequest!.body);
    expect(commands).toContain("thin-pack");
    expect(commands).toContain(`have ${mainCommitHash}`);
    expect(commands).toContain(`have ${featureCommitHash}`);

    const result2 = await applyDraft(plan2);
    expect(result2.updatedRefs.get("refs/heads/main")).toBe(sha1(latestMainCommitHash));
    expect(repo.refs.read("refs/heads/main")).toBe(sha1(latestMainCommitHash));
    expect(repo.refs.read("refs/heads/feature")).toBe(sha1(featureCommitHash));
  });
});

describe("v2 协议 - mixed history 协商形态", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;
  let initialCommitHash: string;
  let mainCommitHash: string;
  let latestMainCommitHash: string;
  let orphanCommitHash: string;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2-mixed-history");
    serverRepoDir = join(tempDir, "server.git");
    workDir = join(tempDir, "work");

    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);

    gitInit(workDir);
    createFile(workDir, "README.md", "A\n");
    git(["add", "README.md"], workDir);
    git(["commit", "-m", "A"], workDir);
    initialCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    createFile(workDir, "main.txt", "B\n");
    git(["add", "main.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    mainCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("快进分支 + 无共同历史分支时，请求序列贴近 git CLI", async () => {
    const repo = initRepository(join(tempDir, "local-mixed-history"));

    const session1 = await repo.openImportSession({ url });
    const plan1 = session1
      .plan()
      .materialize(session1.defaultBranch())
      .toBranch("main")
      .materialize(session1.defaultBranch())
      .setHead();
    await applyDraft(plan1);

    createFile(workDir, "main2.txt", "C\n");
    git(["add", "main2.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    latestMainCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "--orphan", "orphan"], workDir);
    git(["rm", "-rf", "."], workDir);
    createFile(workDir, "orphan.txt", "O\n");
    git(["add", "orphan.txt"], workDir);
    git(["commit", "-m", "O"], workDir);
    orphanCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "orphan"], workDir);

    server.clearRequests();

    const session2 = await repo.openImportSession({ url });
    const plan2 = session2
      .plan()
      .materialize(session2.select("refs/heads/*"))
      .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } });
    const preview2 = await previewDraft(plan2);
    expect(preview2.canApply).toBe(true);

    const fetchRequests = getUploadPackRequests(server.requests).filter((request) =>
      decodeUploadPackCommands(request.body).includes("command=fetch"),
    );
    expect(fetchRequests).toHaveLength(2);

    const firstCommands = decodeUploadPackCommands(fetchRequests[0]!.body);
    expect(firstCommands).toContain(`want ${latestMainCommitHash}`);
    expect(firstCommands).toContain(`want ${orphanCommitHash}`);
    expect(firstCommands).toContain(`have ${mainCommitHash}`);
    expect(firstCommands).toContain(`have ${initialCommitHash}`);
    expect(firstCommands).not.toContain("done");

    const secondCommands = decodeUploadPackCommands(fetchRequests[1]!.body);
    expect(secondCommands).toContain(`want ${latestMainCommitHash}`);
    expect(secondCommands).toContain(`want ${orphanCommitHash}`);
    expect(secondCommands).toContain(`have ${mainCommitHash}`);
    expect(secondCommands).toContain("done");
    expect(secondCommands).not.toContain(`have ${initialCommitHash}`);
  });
});

describe("v2 协议 - 覆盖祖先 tip 的协商形态", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;
  let mainCommitHash: string;
  let featureCommitHash: string;
  let latestMainCommitHash: string;
  let orphanCommitHash: string;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2-covered-tip");
    serverRepoDir = join(tempDir, "server.git");
    workDir = join(tempDir, "work");

    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);

    gitInit(workDir);
    createFile(workDir, "a.txt", "A\n");
    git(["add", "a.txt"], workDir);
    git(["commit", "-m", "A"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    mainCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "-b", "feature"], workDir);
    createFile(workDir, "f.txt", "F\n");
    git(["add", "f.txt"], workDir);
    git(["commit", "-m", "F"], workDir);
    featureCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "feature"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("当一个本地 tip 已覆盖另一个 tip 时，首轮只发送覆盖后的 tip", async () => {
    const repo = initRepository(join(tempDir, "local-covered-tip"));

    const session1 = await repo.openImportSession({ url });
    const plan1 = session1
      .plan()
      .materialize(session1.select("refs/heads/*"))
      .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } })
      .materialize(session1.defaultBranch())
      .setHead();
    await applyDraft(plan1);

    git(["checkout", "main"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    latestMainCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "--orphan", "orphan"], workDir);
    git(["rm", "-rf", "."], workDir);
    createFile(workDir, "o.txt", "O\n");
    git(["add", "o.txt"], workDir);
    git(["commit", "-m", "O"], workDir);
    orphanCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "orphan"], workDir);

    server.clearRequests();

    const session2 = await repo.openImportSession({ url });
    const plan2 = session2
      .plan()
      .materialize(session2.select("refs/heads/*"))
      .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } });
    const preview2 = await previewDraft(plan2);
    expect(preview2.canApply).toBe(true);

    const fetchRequests = getUploadPackRequests(server.requests).filter((request) =>
      decodeUploadPackCommands(request.body).includes("command=fetch"),
    );
    expect(fetchRequests).toHaveLength(2);

    const firstCommands = decodeUploadPackCommands(fetchRequests[0]!.body);
    expect(firstCommands).toContain(`want ${latestMainCommitHash}`);
    expect(firstCommands).toContain(`want ${orphanCommitHash}`);
    expect(firstCommands).toContain(`have ${featureCommitHash}`);
    expect(firstCommands).not.toContain(`have ${mainCommitHash}`);

    const secondCommands = decodeUploadPackCommands(fetchRequests[1]!.body);
    expect(secondCommands).toContain(`have ${featureCommitHash}`);
    expect(secondCommands).not.toContain(`have ${mainCommitHash}`);
    expect(secondCommands).toContain("done");
  });
});

describe("v2 协议 - git-http-backend ready cut-point", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;
  let mainCommitHash: string;
  let featureCommitHash: string;
  let latestMainCommitHash: string;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2-ready-cut-point");
    serverRepoDir = join(tempDir, "server.git");
    workDir = join(tempDir, "work");

    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);

    gitInit(workDir);
    createFile(workDir, "a.txt", "A\n");
    git(["add", "a.txt"], workDir);
    git(["commit", "-m", "A"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    mainCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "-b", "feature"], workDir);
    createFile(workDir, "f.txt", "F\n");
    git(["add", "f.txt"], workDir);
    git(["commit", "-m", "F"], workDir);
    featureCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "feature"], workDir);

    git(["checkout", "main"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    latestMainCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("当 have 的祖先已覆盖 want 切点时，git-http-backend 会直接返回 ready + packfile", async () => {
    const body = Buffer.concat([
      encodePktLine("command=fetch\n"),
      encodePktLine("agent=nano-git-test\n"),
      encodePktLine("object-format=sha1\n"),
      encodeDelimiterPkt(),
      encodePktLine(`want ${latestMainCommitHash}\n`),
      encodePktLine(`have ${featureCommitHash}\n`),
      encodeFlushPkt(),
    ]);

    const response = await fetch(`${url}/git-upload-pack`, {
      method: "POST",
      headers: {
        "content-type": "application/x-git-upload-pack-request",
        "git-protocol": "version=2",
      },
      body,
    });

    expect(response.status).toBe(200);
    const parsed = parseV2FetchResponse(Buffer.from(await response.arrayBuffer()), false, false);
    expect(parsed.acknowledgments?.acks).toEqual([featureCommitHash]);
    expect(parsed.acknowledgments?.ready).toBe(true);
    expect(parsed.packfile).toBeDefined();
    expect(mainCommitHash).not.toBe(featureCommitHash);
  });
});

describe("v2 协议 - ready cut-point 端到端协商", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;
  let featureCommitHash: string;
  let latestMainCommitHash: string;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2-ready-cut-point-flow");
    serverRepoDir = join(tempDir, "server.git");
    workDir = join(tempDir, "work");

    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);

    gitInit(workDir);
    createFile(workDir, "a.txt", "A\n");
    git(["add", "a.txt"], workDir);
    git(["commit", "-m", "A"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "-b", "feature"], workDir);
    createFile(workDir, "f.txt", "F\n");
    git(["add", "f.txt"], workDir);
    git(["commit", "-m", "F"], workDir);
    featureCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "feature"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("当公共后代已覆盖 main 的切点时，nano-git 一轮 fetch 即完成协商", async () => {
    const repo = initRepository(join(tempDir, "local-ready-cut-point"));

    const session1 = await repo.openImportSession({ url });
    const plan1 = session1
      .plan()
      .materialize(session1.select("refs/heads/*"))
      .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } })
      .materialize(session1.defaultBranch())
      .setHead();
    await applyDraft(plan1);

    git(["checkout", "main"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    latestMainCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    server.clearRequests();

    const session2 = await repo.openImportSession({ url });
    const plan2 = session2
      .plan()
      .materialize(session2.select("refs/heads/*"))
      .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } });
    const preview2 = await previewDraft(plan2);
    expect(preview2.canApply).toBe(true);

    const fetchRequests = getUploadPackRequests(server.requests).filter((request) =>
      decodeUploadPackCommands(request.body).includes("command=fetch"),
    );
    expect(fetchRequests).toHaveLength(1);

    const commands = decodeUploadPackCommands(fetchRequests[0]!.body);
    expect(commands).toContain(`want ${latestMainCommitHash}`);
    expect(commands).toContain(`have ${featureCommitHash}`);
    expect(commands).not.toContain("done");
  });
});

describe("v2 协议 - known common covered tip 协商形态", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;
  let mainCommitHash: string;
  let featureCommitHash: string;
  let latestFeatureCommitHash: string;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2-known-common-covered-tip");
    serverRepoDir = join(tempDir, "server.git");
    workDir = join(tempDir, "work");

    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);

    gitInit(workDir);
    createFile(workDir, "a.txt", "A\n");
    git(["add", "a.txt"], workDir);
    git(["commit", "-m", "A"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    mainCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "-b", "feature"], workDir);
    createFile(workDir, "f1.txt", "F1\n");
    git(["add", "f1.txt"], workDir);
    git(["commit", "-m", "F1"], workDir);
    featureCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "feature"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("当被覆盖 tip 同时是远端公共 ref 时，请求序列贴近 git CLI", async () => {
    const repo = initRepository(join(tempDir, "local-known-common-covered-tip"));

    const session1 = await repo.openImportSession({ url });
    const plan1 = session1
      .plan()
      .materialize(session1.select("refs/heads/*"))
      .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } })
      .materialize(session1.defaultBranch())
      .setHead();
    await applyDraft(plan1);

    git(["checkout", "feature"], workDir);
    createFile(workDir, "f2.txt", "F2\n");
    git(["add", "f2.txt"], workDir);
    git(["commit", "-m", "F2"], workDir);
    latestFeatureCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "feature"], workDir);

    server.clearRequests();

    const session2 = await repo.openImportSession({ url });
    const plan2 = session2
      .plan()
      .materialize(session2.select("refs/heads/*"))
      .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } });
    const preview2 = await previewDraft(plan2);
    expect(preview2.canApply).toBe(true);

    const fetchRequests = getUploadPackRequests(server.requests).filter((request) =>
      decodeUploadPackCommands(request.body).includes("command=fetch"),
    );
    expect(fetchRequests).toHaveLength(1);

    const commands = decodeUploadPackCommands(fetchRequests[0]!.body);
    expect(commands).toContain(`want ${latestFeatureCommitHash}`);
    expect(commands).toContain(`have ${featureCommitHash}`);
    expect(commands).toContain(`have ${mainCommitHash}`);
    expect(commands.indexOf(`have ${mainCommitHash}`)).toBeLessThan(
      commands.indexOf(`have ${featureCommitHash}`),
    );
  });
});

describe("v2 协议 - annotated tag have 协商", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;
  let mainCommitHash: string;
  let tagHash: string;
  let latestMainCommitHash: string;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2-annotated-tag-have");
    serverRepoDir = join(tempDir, "server.git");
    workDir = join(tempDir, "work");

    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);

    gitInit(workDir);
    createFile(workDir, "a.txt", "A\n");
    git(["add", "a.txt"], workDir);
    git(["commit", "-m", "A"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    mainCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["tag", "-a", "v1.0.0", "-m", "v1.0.0"], workDir);
    tagHash = git(["rev-parse", "refs/tags/v1.0.0"], workDir);
    git(["push", serverRepoDir, "main"], workDir);
    git(["push", serverRepoDir, "refs/tags/v1.0.0"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("本地存在 annotated tag 时，fetch 协商不会把 tag 对象本身作为 have 发出", async () => {
    const repo = initRepository(join(tempDir, "local-annotated-tag-have"));

    const session1 = await repo.openImportSession({ url });
    const plan1 = session1
      .plan()
      .materialize(session1.select("refs/heads/*"))
      .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } })
      .materialize(session1.select("refs/tags/*"))
      .toNamespace("refs/tags/*", { policy: { mode: "create-only" } })
      .materialize(session1.defaultBranch())
      .setHead();
    await applyDraft(plan1);

    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    latestMainCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    server.clearRequests();

    const session2 = await repo.openImportSession({ url });
    const plan2 = session2
      .plan()
      .materialize(session2.select("refs/heads/*"))
      .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } });
    const preview2 = await previewDraft(plan2);
    expect(preview2.canApply).toBe(true);

    const fetchRequests = getUploadPackRequests(server.requests).filter((request) =>
      decodeUploadPackCommands(request.body).includes("command=fetch"),
    );
    expect(fetchRequests).toHaveLength(1);

    const commands = decodeUploadPackCommands(fetchRequests[0]!.body);
    expect(commands).toContain(`want ${latestMainCommitHash}`);
    expect(commands).toContain(`have ${mainCommitHash}`);
    expect(commands).not.toContain(`have ${tagHash}`);
  });
});

describe("v2 协议 - 与 git CLI 的请求序列对照", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;
  let url: string;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-v2-cli-compare");
    serverRepoDir = join(tempDir, "server.git");
    workDir = join(tempDir, "work");

    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("feature fast-forward 场景下 fetch 请求序列与 git CLI 一致", async () => {
    gitInit(workDir);
    createFile(workDir, "a.txt", "A\n");
    git(["add", "a.txt"], workDir);
    git(["commit", "-m", "A"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "-b", "feature"], workDir);
    createFile(workDir, "f1.txt", "F1\n");
    git(["add", "f1.txt"], workDir);
    git(["commit", "-m", "F1"], workDir);
    git(["push", serverRepoDir, "feature"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;

    const nanoRepo = await cloneNanoHeads(url, join(tempDir, "local-nano-feature-ff"));
    const gitCliDir = join(tempDir, "local-git-feature-ff");
    await cloneGitCli(url, gitCliDir, tempDir);

    createFile(workDir, "f2.txt", "F2\n");
    git(["add", "f2.txt"], workDir);
    git(["commit", "-m", "F2"], workDir);
    git(["push", serverRepoDir, "feature"], workDir);

    server.clearRequests();
    const nanoPreview = await fetchNanoHeads(nanoRepo, url);
    expect(nanoPreview.canApply).toBe(true);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await fetchGitCli(gitCliDir);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
  });

  test("两个分支同时 fast-forward 时 fetch 请求序列与 git CLI 一致", async () => {
    gitInit(workDir);
    createFile(workDir, "a.txt", "A\n");
    git(["add", "a.txt"], workDir);
    git(["commit", "-m", "A"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "-b", "topic"], workDir);
    createFile(workDir, "t1.txt", "T1\n");
    git(["add", "t1.txt"], workDir);
    git(["commit", "-m", "T1"], workDir);
    git(["push", serverRepoDir, "topic"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;

    const nanoRepo = await cloneNanoHeads(url, join(tempDir, "local-nano-two-ff"));
    const gitCliDir = join(tempDir, "local-git-two-ff");
    await cloneGitCli(url, gitCliDir, tempDir);

    git(["checkout", "main"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "topic"], workDir);
    createFile(workDir, "t2.txt", "T2\n");
    git(["add", "t2.txt"], workDir);
    git(["commit", "-m", "T2"], workDir);
    git(["push", serverRepoDir, "topic"], workDir);

    server.clearRequests();
    const nanoPreview = await fetchNanoHeads(nanoRepo, url);
    expect(nanoPreview.canApply).toBe(true);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await fetchGitCli(gitCliDir);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
  });

  test("merge 分支和 topic 同时推进时 fetch 请求序列与 git CLI 一致", async () => {
    gitInit(workDir);
    createFile(workDir, "a.txt", "A\n");
    git(["add", "a.txt"], workDir);
    git(["commit", "-m", "A"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "-b", "topic"], workDir);
    createFile(workDir, "t1.txt", "T1\n");
    git(["add", "t1.txt"], workDir);
    git(["commit", "-m", "T1"], workDir);
    git(["push", serverRepoDir, "topic"], workDir);

    git(["checkout", "main"], workDir);
    git(["merge", "--no-ff", "topic", "-m", "M1"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;

    const nanoRepo = await cloneNanoHeads(url, join(tempDir, "local-nano-merge-topic"));
    const gitCliDir = join(tempDir, "local-git-merge-topic");
    await cloneGitCli(url, gitCliDir, tempDir);

    git(["checkout", "topic"], workDir);
    createFile(workDir, "t2.txt", "T2\n");
    git(["add", "t2.txt"], workDir);
    git(["commit", "-m", "T2"], workDir);
    git(["push", serverRepoDir, "topic"], workDir);

    git(["checkout", "main"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    git(["merge", "--no-ff", "topic", "-m", "M2"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    server.clearRequests();
    const nanoPreview = await fetchNanoHeads(nanoRepo, url);
    expect(nanoPreview.canApply).toBe(true);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await fetchGitCli(gitCliDir);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
  });

  test("criss-cross 风格 merge 场景下 fetch 请求序列与 git CLI 一致", async () => {
    gitInit(workDir);
    createFile(workDir, "a.txt", "A\n");
    git(["add", "a.txt"], workDir);
    git(["commit", "-m", "A"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "-b", "topic"], workDir);
    createFile(workDir, "t1.txt", "T1\n");
    git(["add", "t1.txt"], workDir);
    git(["commit", "-m", "T1"], workDir);
    git(["push", serverRepoDir, "topic"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;

    const nanoRepo = await cloneNanoHeads(url, join(tempDir, "local-nano-criss-cross"));
    const gitCliDir = join(tempDir, "local-git-criss-cross");
    await cloneGitCli(url, gitCliDir, tempDir);

    git(["checkout", "main"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    git(["merge", "--no-ff", "topic", "-m", "merge topic into main"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "topic"], workDir);
    createFile(workDir, "t2.txt", "T2\n");
    git(["add", "t2.txt"], workDir);
    git(["commit", "-m", "T2"], workDir);
    git(["merge", "--no-ff", "main", "-m", "merge main into topic"], workDir);
    git(["push", serverRepoDir, "topic"], workDir);

    server.clearRequests();
    const nanoPreview = await fetchNanoHeads(nanoRepo, url);
    expect(nanoPreview.canApply).toBe(true);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await fetchGitCli(gitCliDir);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
  });

  test("多共享分支前沿场景下 fetch 请求序列与 git CLI 一致", async () => {
    gitInit(workDir);
    createFile(workDir, "a.txt", "A\n");
    git(["add", "a.txt"], workDir);
    git(["commit", "-m", "A"], workDir);

    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);

    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "-b", "topic-a", "HEAD~1"], workDir);
    createFile(workDir, "ta1.txt", "TA1\n");
    git(["add", "ta1.txt"], workDir);
    git(["commit", "-m", "TA1"], workDir);
    git(["push", serverRepoDir, "topic-a"], workDir);

    git(["checkout", "main"], workDir);
    git(["checkout", "-b", "topic-b", "HEAD~1"], workDir);
    createFile(workDir, "tb1.txt", "TB1\n");
    git(["add", "tb1.txt"], workDir);
    git(["commit", "-m", "TB1"], workDir);
    git(["push", serverRepoDir, "topic-b"], workDir);

    git(["checkout", "main"], workDir);
    git(["checkout", "-b", "topic-c"], workDir);
    createFile(workDir, "tc1.txt", "TC1\n");
    git(["add", "tc1.txt"], workDir);
    git(["commit", "-m", "TC1"], workDir);
    git(["push", serverRepoDir, "topic-c"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;

    const nanoRepo = await cloneNanoHeads(url, join(tempDir, "local-nano-many-shared"));
    const gitCliDir = join(tempDir, "local-git-many-shared");
    await cloneGitCli(url, gitCliDir, tempDir);

    git(["checkout", "main"], workDir);
    createFile(workDir, "d.txt", "D\n");
    git(["add", "d.txt"], workDir);
    git(["commit", "-m", "D"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "topic-a"], workDir);
    createFile(workDir, "ta2.txt", "TA2\n");
    git(["add", "ta2.txt"], workDir);
    git(["commit", "-m", "TA2"], workDir);
    git(["push", serverRepoDir, "topic-a"], workDir);

    git(["checkout", "topic-b"], workDir);
    createFile(workDir, "tb2.txt", "TB2\n");
    git(["add", "tb2.txt"], workDir);
    git(["commit", "-m", "TB2"], workDir);
    git(["push", serverRepoDir, "topic-b"], workDir);

    git(["checkout", "-b", "hotfix", "main~2"], workDir);
    createFile(workDir, "h1.txt", "H1\n");
    git(["add", "h1.txt"], workDir);
    git(["commit", "-m", "H1"], workDir);
    git(["push", serverRepoDir, "hotfix"], workDir);

    server.clearRequests();
    const nanoPreview = await fetchNanoHeads(nanoRepo, url);
    expect(nanoPreview.canApply).toBe(true);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await fetchGitCli(gitCliDir);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
  });

  test("known common 后代已覆盖公共祖先时 fetch 请求序列与 git CLI 一致", async () => {
    let mainCommitHash: string;
    let topicCommitHash: string;
    let knownCommitHash: string;

    gitInit(workDir);
    createFile(workDir, "a.txt", "A\n");
    git(["add", "a.txt"], workDir);
    git(["commit", "-m", "A"], workDir);
    mainCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "-b", "topic"], workDir);
    createFile(workDir, "topic-1.txt", "topic-1\n");
    git(["add", "topic-1.txt"], workDir);
    git(["commit", "-m", "topic-1"], workDir);
    topicCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "topic"], workDir);

    git(["checkout", "main"], workDir);
    git(["checkout", "-b", "known"], workDir);
    createFile(workDir, "known-1.txt", "known-1\n");
    git(["add", "known-1.txt"], workDir);
    git(["commit", "-m", "known-1"], workDir);
    knownCommitHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "known"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;

    const nanoRepo = await cloneNanoHeads(url, join(tempDir, "local-nano-known-descendant"));
    const gitCliDir = join(tempDir, "local-git-known-descendant");
    await cloneGitCli(url, gitCliDir, tempDir);

    git(["checkout", "topic"], workDir);
    createFile(workDir, "topic-2.txt", "topic-2\n");
    git(["add", "topic-2.txt"], workDir);
    git(["commit", "-m", "topic-2"], workDir);
    git(["push", serverRepoDir, "topic"], workDir);

    server.clearRequests();
    const nanoPreview = await fetchNanoHeads(nanoRepo, url);
    expect(nanoPreview.canApply).toBe(true);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await fetchGitCli(gitCliDir);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);

    const firstNanoBatch = nanoBatches[0] ?? [];
    expect(firstNanoBatch).toContain(`have ${knownCommitHash}`);
    expect(firstNanoBatch).toContain(`have ${topicCommitHash}`);
    expect(firstNanoBatch).not.toContain(`have ${mainCommitHash}`);
  });

  test("长主线 + 多公共分支场景下第二轮 common replay 顺序与 git CLI 一致", async () => {
    gitInit(workDir);
    createFile(workDir, "main-1.txt", "main-1\n");
    git(["add", "main-1.txt"], workDir);
    git(["commit", "-m", "main-1"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    for (let index = 2; index <= 46; index++) {
      createFile(workDir, `main-${index}.txt`, `main-${index}\n`);
      git(["add", `main-${index}.txt`], workDir);
      git(["commit", "-m", `main-${index}`], workDir);
      git(["push", serverRepoDir, "main"], workDir);
    }

    git(["checkout", "main~15"], workDir);
    git(["checkout", "-b", "topic-old"], workDir);
    createFile(workDir, "topic-old-1.txt", "topic-old-1\n");
    git(["add", "topic-old-1.txt"], workDir);
    git(["commit", "-m", "topic-old-1"], workDir);
    git(["push", serverRepoDir, "topic-old"], workDir);

    git(["checkout", "main~5"], workDir);
    git(["checkout", "-b", "topic-recent"], workDir);
    createFile(workDir, "topic-recent-1.txt", "topic-recent-1\n");
    git(["add", "topic-recent-1.txt"], workDir);
    git(["commit", "-m", "topic-recent-1"], workDir);
    git(["push", serverRepoDir, "topic-recent"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;

    const nanoRepo = await cloneNanoHeads(url, join(tempDir, "local-nano-replay-order"));
    const gitCliDir = join(tempDir, "local-git-replay-order");
    await cloneGitCli(url, gitCliDir, tempDir);

    git(["checkout", "main"], workDir);
    for (let index = 47; index <= 54; index++) {
      createFile(workDir, `main-${index}.txt`, `main-${index}\n`);
      git(["add", `main-${index}.txt`], workDir);
      git(["commit", "-m", `main-${index}`], workDir);
      git(["push", serverRepoDir, "main"], workDir);
    }

    git(["checkout", "topic-old"], workDir);
    for (let index = 2; index <= 4; index++) {
      createFile(workDir, `topic-old-${index}.txt`, `topic-old-${index}\n`);
      git(["add", `topic-old-${index}.txt`], workDir);
      git(["commit", "-m", `topic-old-${index}`], workDir);
      git(["push", serverRepoDir, "topic-old"], workDir);
    }

    git(["checkout", "topic-recent"], workDir);
    for (let index = 2; index <= 3; index++) {
      createFile(workDir, `topic-recent-${index}.txt`, `topic-recent-${index}\n`);
      git(["add", `topic-recent-${index}.txt`], workDir);
      git(["commit", "-m", `topic-recent-${index}`], workDir);
      git(["push", serverRepoDir, "topic-recent"], workDir);
    }
    git(["merge", "--no-ff", "main", "-m", "merge main into topic-recent"], workDir);
    git(["push", serverRepoDir, "topic-recent"], workDir);

    git(["checkout", "-b", "hotfix", "main~20"], workDir);
    createFile(workDir, "hotfix-1.txt", "hotfix-1\n");
    git(["add", "hotfix-1.txt"], workDir);
    git(["commit", "-m", "hotfix-1"], workDir);
    git(["push", serverRepoDir, "hotfix"], workDir);

    git(["checkout", "--orphan", "orphan-new"], workDir);
    git(["rm", "-rf", "."], workDir);
    createFile(workDir, "orphan-1.txt", "orphan-1\n");
    git(["add", "orphan-1.txt"], workDir);
    git(["commit", "-m", "orphan-1"], workDir);
    git(["push", serverRepoDir, "orphan-new"], workDir);

    server.clearRequests();
    const nanoPreview = await fetchNanoHeads(nanoRepo, url);
    expect(nanoPreview.canApply).toBe(true);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await fetchGitCli(gitCliDir);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
  });

  test("长历史 + orphan 场景下多轮 fetch 请求序列与 git CLI 一致", async () => {
    gitInit(workDir);
    for (let i = 1; i <= 40; i++) {
      createFile(workDir, `a${i}.txt`, `A${i}\n`);
      git(["add", `a${i}.txt`], workDir);
      git(["commit", "-m", `A${i}`], workDir);
    }
    git(["push", serverRepoDir, "main"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;

    const nanoRepo = await cloneNanoHeads(url, join(tempDir, "local-nano-long-orphan"));
    const gitCliDir = join(tempDir, "local-git-long-orphan");
    await cloneGitCli(url, gitCliDir, tempDir);

    createFile(workDir, "a41.txt", "A41\n");
    git(["add", "a41.txt"], workDir);
    git(["commit", "-m", "A41"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["checkout", "--orphan", "orphan"], workDir);
    git(["rm", "-rf", "."], workDir);
    createFile(workDir, "o1.txt", "O1\n");
    git(["add", "o1.txt"], workDir);
    git(["commit", "-m", "O1"], workDir);
    git(["push", serverRepoDir, "orphan"], workDir);

    server.clearRequests();
    const nanoPreview = await fetchNanoHeads(nanoRepo, url);
    expect(nanoPreview.canApply).toBe(true);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await fetchGitCli(gitCliDir);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
  });

  test("显式 tag 物化但远端暂无 tag 时 fetch 请求序列与 git CLI 一致", async () => {
    gitInit(workDir);
    createFile(workDir, "a.txt", "A\n");
    git(["add", "a.txt"], workDir);
    git(["commit", "-m", "A"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;

    const nanoRepo = await cloneNanoHeadsAndTags(url, join(tempDir, "local-nano-no-tag"));
    const gitCliDir = join(tempDir, "local-git-no-tag");
    await cloneGitCli(url, gitCliDir, tempDir);

    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    server.clearRequests();
    const nanoPreview = await fetchNanoHeadsAndTags(nanoRepo, url);
    expect(nanoPreview.canApply).toBe(true);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await fetchGitCli(gitCliDir, { tags: true });
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
  });

  test("lightweight tag 与分支指向同一新提交时 fetch 请求序列与 git CLI 一致", async () => {
    let commitHash: string;

    gitInit(workDir);
    createFile(workDir, "a.txt", "A\n");
    git(["add", "a.txt"], workDir);
    git(["commit", "-m", "A"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;

    const nanoRepo = await cloneNanoHeadsAndTags(url, join(tempDir, "local-nano-lightweight-tag"));
    const gitCliDir = join(tempDir, "local-git-lightweight-tag");
    await cloneGitCli(url, gitCliDir, tempDir);

    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    commitHash = git(["rev-parse", "HEAD"], workDir);
    git(["tag", "v1.0.0-lightweight"], workDir);
    git(["push", serverRepoDir, "main"], workDir);
    git(["push", serverRepoDir, "refs/tags/v1.0.0-lightweight"], workDir);

    server.clearRequests();
    const nanoPreview = await fetchNanoHeadsAndTags(nanoRepo, url);
    expect(nanoPreview.canApply).toBe(true);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await fetchGitCli(gitCliDir, { tags: true });
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);

    const firstNanoBatch = nanoBatches[0] ?? [];
    expect(firstNanoBatch.filter((line) => line === `want ${commitHash}`).length).toBe(2);
  });

  test("annotated tag 存在时 fetch 请求序列与 git CLI 一致", async () => {
    gitInit(workDir);
    createFile(workDir, "a.txt", "A\n");
    git(["add", "a.txt"], workDir);
    git(["commit", "-m", "A"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    git(["tag", "-a", "v1.0.0", "-m", "v1.0.0"], workDir);
    git(["push", serverRepoDir, "main"], workDir);
    git(["push", serverRepoDir, "refs/tags/v1.0.0"], workDir);

    server = startGitHttpBackendServer(tempDir, "/server.git");
    url = server.url;

    const nanoRepo = await cloneNanoHeadsAndTags(url, join(tempDir, "local-nano-tag"));
    const gitCliDir = join(tempDir, "local-git-tag");
    await cloneGitCli(url, gitCliDir, tempDir);

    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    server.clearRequests();
    const nanoPreview = await fetchNanoHeadsAndTags(nanoRepo, url);
    expect(nanoPreview.canApply).toBe(true);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await fetchGitCli(gitCliDir, { tags: true });
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
  });
});

// v1 回退测试已移除 — nano-git 仅支持 v2 fetch
