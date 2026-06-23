/**
 * Smart HTTP 服务端端到端测试
 *
 * 使用真实 Bun.serve + createSmartHttpHandler 验证服务端功能：
 * - git CLI: clone、fetch
 * - nano-git 客户端: openImportSession、fetch
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import { createTempDir, cleanupDir, gitWithTimeout } from "../helpers.ts";
import { startNanoGitServer, createDefaultBackend } from "./nano-git-server.ts";
import { sha1, type SHA1 } from "@/core/types.ts";
import { createMemoryRepository, initRepository } from "@/repository/index.ts";
import { detectProtocol } from "@/transport/v2/detect.ts";

import type { NanoGitServer } from "./nano-git-server.ts";
import type { RepositoryBackend } from "@/repository/backend/types.ts";

// ============================================================================
// 测试辅助：用系统 git 创建带提交的目录
// ============================================================================

/**
 * 在内存后端上创建一次额外的提交
 */
function addCommit(backend: RepositoryBackend, parent: SHA1, msg: string): SHA1 {
  const blobHash = backend.objects.write({
    type: "blob" as const,
    content: Buffer.from(msg),
  });
  const treeHash = backend.objects.write({
    type: "tree" as const,
    entries: [{ mode: "100644", name: `${msg}.txt`, hash: blobHash }],
  });
  const commitHash = backend.objects.write({
    type: "commit" as const,
    tree: treeHash,
    parents: [parent],
    author: { name: "E2E", email: "e2e@test", timestamp: 2000000001, timezone: "+0000" },
    committer: { name: "E2E", email: "e2e@test", timestamp: 2000000001, timezone: "+0000" },
    message: `${msg}\n`,
  });
  return commitHash;
}

describe("Smart HTTP 服务端 — nano-git 客户端", () => {
  let server: NanoGitServer;
  let tempDir: string;

  beforeEach(() => {
    server = startNanoGitServer();
    tempDir = createTempDir("e2e-server-nano");
  });

  afterEach(() => {
    server.stop();
    cleanupDir(tempDir);
  });

  test("detectProtocol 检测到 v2 能力广告", async () => {
    const result = await detectProtocol(server.url);
    expect(result.protocol).toBe("v2");
    if (result.protocol === "v2") {
      const cmdNames = result.capabilities.commands.map((c) => c.name);
      expect(cmdNames).toContain("ls-refs");
      expect(cmdNames).toContain("fetch");
    }
  });

  test("openImportSession 通过 v2 获取 refs", async () => {
    const repo = createMemoryRepository();
    const session = await repo.openImportSession({ url: server.url });

    const refs = session.advertisement.refs;
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some((r) => r.name === "refs/heads/main")).toBe(true);
  });

  test("openImportSession + apply 克隆到内存仓库", async () => {
    const repo = createMemoryRepository();
    const session = await repo.openImportSession({ url: server.url });

    const defaultBranch = session.defaultBranch();
    expect(defaultBranch.refs.length).toBeGreaterThan(0);

    const plan = session
      .plan()
      .materialize(defaultBranch)
      .toBranch("main")
      .materialize(defaultBranch)
      .setHead();

    const preview = await plan.preview();
    expect(preview.canApply).toBe(true);

    const result = await plan.apply();
    expect(result.updatedRefs.size).toBeGreaterThan(0);
    expect(result.importedObjects).toBeGreaterThan(0);
  });

  test("增量 fetch 拉取新提交到本地仓库", async () => {
    const repo = createMemoryRepository();

    // 首次克隆
    const session1 = await repo.openImportSession({ url: server.url });
    const plan1 = session1
      .plan()
      .materialize(session1.defaultBranch())
      .toBranch("main")
      .materialize(session1.defaultBranch())
      .setHead();
    await plan1.apply();
    const firstHash = sha1(repo.refs.read("refs/heads/main")!);

    // 在服务端增加提交
    const newHash = addCommit(server.backend, firstHash, "second commit");
    server.backend.refs.write("refs/heads/main", newHash);
    server.backend.refs.write("refs/heads/feature", newHash);

    // 增量 fetch
    const session2 = await repo.openImportSession({ url: server.url });
    const mainRef = session2.advertisement.refs.find((r) => r.name === "refs/heads/main");
    expect(mainRef?.hash).toBe(newHash);

    const plan2 = session2
      .plan()
      .materialize(session2.select("refs/heads/*"))
      .toNamespace("refs/heads/*", { policy: { mode: "fast-forward" } });

    const preview2 = await plan2.preview();
    expect(preview2.canApply).toBe(true);

    const result2 = await plan2.apply();
    expect(result2.updatedRefs.get("refs/heads/main")).toBe(newHash);

    // 验证新提交的树对象
    const mainCommit = repo.catFile(newHash);
    expect(mainCommit.type).toBe("commit");

    // 验证 feature 分支也存在
    expect(repo.refs.read("refs/heads/feature")).toBe(newHash);
  });

  test("ls-refs 结果可通过 v1 RefAdvertisement 与 v2 互转", async () => {
    const repo = createMemoryRepository();
    const session = await repo.openImportSession({ url: server.url });

    const adv = session.advertisement;
    expect(adv.refs.length).toBeGreaterThan(0);
    expect(adv.defaultBranch).toBeDefined();
    expect(adv.capabilities).toBeDefined();
  });
});

// ============================================================================
// 带文件系统的端到端测试
// ============================================================================

describe("Smart HTTP 服务端 — 文件系统仓库 e2e", () => {
  let server: NanoGitServer;
  let tempDir: string;

  beforeEach(() => {
    // 建立文件系统仓库
    const backend = createDefaultBackend();
    server = startNanoGitServer(backend);
    tempDir = createTempDir("e2e-server-fs");
  });

  afterEach(() => {
    server.stop();
    cleanupDir(tempDir);
  });

  test("initRepository + openImportSession 通过 v2 导入 refs", async () => {
    const repo = initRepository(`${tempDir}/local`);

    const session = await repo.openImportSession({ url: server.url });
    const refs = session.advertisement.refs;
    expect(refs.length).toBeGreaterThan(0);

    const plan = session
      .plan()
      .materialize(session.defaultBranch())
      .toBranch("main")
      .materialize(session.defaultBranch())
      .setHead();
    const result = await plan.apply();
    expect(result.importedObjects).toBeGreaterThan(0);
    expect(result.updatedRefs.has("refs/heads/main")).toBe(true);
  });
});

// ============================================================================
// git CLI 端到端测试
//
// 用真实 git 命令行连接 nano-git 服务端，验证 Git Wire 协议 v2 兼容性。
// 注意：git 命令统一设置超时，避免实现缺陷导致测试进程卡死。
// ============================================================================

/** git 命令统一超时（毫秒）——服务端响应不完整时及早失败而非挂起 */
const GIT_TIMEOUT_MS = 15000;

/** 强制 git 使用 v2 协议并禁用交互的额外参数 */
const GIT_V2_ARGS = ["-c", "protocol.version=2"];

describe("Smart HTTP 服务端 — git CLI e2e", () => {
  let server: NanoGitServer;
  let tempDir: string;

  beforeEach(() => {
    server = startNanoGitServer();
    tempDir = createTempDir("e2e-server-gitcli");
  });

  afterEach(() => {
    server.stop();
    cleanupDir(tempDir);
  });

  test("git ls-remote 列出服务端引用", async () => {
    const out = await gitWithTimeout(
      [...GIT_V2_ARGS, "ls-remote", server.url],
      tempDir,
      GIT_TIMEOUT_MS,
    );

    expect(out).toContain("refs/heads/main");
  });

  test("git clone 克隆服务端仓库", async () => {
    const target = `${tempDir}/cloned`;

    await gitWithTimeout([...GIT_V2_ARGS, "clone", server.url, target], tempDir, GIT_TIMEOUT_MS);

    // 验证克隆得到的 HEAD 指向服务端的提交
    const head = await gitWithTimeout(
      [...GIT_V2_ARGS, "rev-parse", "HEAD"],
      target,
      GIT_TIMEOUT_MS,
    );
    const serverMain = server.backend.refs.read("refs/heads/main")!;
    expect(head).toBe(serverMain);

    // 验证克隆出来的文件内容
    const fileContent = await gitWithTimeout(
      [...GIT_V2_ARGS, "show", "HEAD:README.txt"],
      target,
      GIT_TIMEOUT_MS,
    );
    expect(fileContent).toContain("nano-git e2e test");
  });

  test("git clone 后 fsck 校验仓库完整性", async () => {
    const target = `${tempDir}/cloned-fsck`;

    await gitWithTimeout([...GIT_V2_ARGS, "clone", server.url, target], tempDir, GIT_TIMEOUT_MS);

    // fsck 不应报告任何错误
    await gitWithTimeout([...GIT_V2_ARGS, "fsck", "--no-dangling"], target, GIT_TIMEOUT_MS);
  });

  test("git fetch 增量拉取新提交", async () => {
    const target = `${tempDir}/cloned-fetch`;

    // 首次克隆
    await gitWithTimeout([...GIT_V2_ARGS, "clone", server.url, target], tempDir, GIT_TIMEOUT_MS);
    const firstHash = sha1(server.backend.refs.read("refs/heads/main")!);

    // 服务端追加提交
    const newHash = addCommit(server.backend, firstHash, "second commit");
    server.backend.refs.write("refs/heads/main", newHash);

    // 客户端增量 fetch
    await gitWithTimeout([...GIT_V2_ARGS, "fetch", "origin"], target, GIT_TIMEOUT_MS);

    const remoteMain = await gitWithTimeout(
      [...GIT_V2_ARGS, "rev-parse", "origin/main"],
      target,
      GIT_TIMEOUT_MS,
    );
    expect(remoteMain).toBe(newHash);
  });
});
