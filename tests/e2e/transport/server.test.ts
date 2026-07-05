/**
 * Smart HTTP 服务端端到端测试
 *
 * 使用真实 Bun.serve + createSmartHttpHandler 验证服务端功能：
 * - git CLI: clone、fetch
 * - nano-git 客户端: openImportSession、fetch
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createTempDir, cleanupDir, gitWithTimeout } from "../helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { startNanoGitServer, createDefaultBackend } from "./nano-git-server.ts";
import { createFileRepositoryBackend } from "@/backend/file.ts";
import { writeObject } from "@/objects/raw.ts";
import { initRepository } from "@/repository/file.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { v2Fetch } from "@/transport/client/upload-pack/fetch.ts";
import { createV2HttpTransport } from "@/transport/client/upload-pack/http.ts";
import { sha1, type SHA1 } from "@/types/index.ts";

import type { NanoGitServer } from "./nano-git-server.ts";
import type { RepositoryBackend } from "@/backend/types.ts";
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

// ============================================================================
// 测试辅助：用系统 git 创建带提交的目录
// ============================================================================

/**
 * 在内存后端上创建一次额外的提交
 */
function addCommit(backend: RepositoryBackend, parent: SHA1, msg: string): SHA1 {
  const blobHash = writeObject(backend.objects, {
    type: "blob" as const,
    content: Buffer.from(msg),
  });
  const treeHash = writeObject(backend.objects, {
    type: "tree" as const,
    entries: [{ mode: "100644", name: `${msg}.txt`, hash: blobHash }],
  });
  const commitHash = writeObject(backend.objects, {
    type: "commit" as const,
    tree: treeHash,
    parents: [parent],
    author: { name: "E2E", email: "e2e@test", timestamp: 2000000001, timezone: "+0000" },
    committer: { name: "E2E", email: "e2e@test", timestamp: 2000000001, timezone: "+0000" },
    message: `${msg}\n`,
  });
  return commitHash;
}

/**
 * 在内存后端上创建一个无共同历史的根提交
 */
function addRootCommit(backend: RepositoryBackend, msg: string): SHA1 {
  const blobHash = writeObject(backend.objects, {
    type: "blob" as const,
    content: Buffer.from(msg),
  });
  const treeHash = writeObject(backend.objects, {
    type: "tree" as const,
    entries: [{ mode: "100644", name: `${msg}.txt`, hash: blobHash }],
  });
  return writeObject(backend.objects, {
    type: "commit" as const,
    tree: treeHash,
    parents: [],
    author: { name: "E2E", email: "e2e@test", timestamp: 2000000100, timezone: "+0000" },
    committer: { name: "E2E", email: "e2e@test", timestamp: 2000000100, timezone: "+0000" },
    message: `${msg}\n`,
  });
}

function readShallowFile(workDir: string): string[] {
  const shallowPath = join(workDir, ".git", "shallow");
  if (!existsSync(shallowPath)) {
    return [];
  }

  const content = readFileSync(shallowPath, "utf-8").trim();
  return content.length === 0 ? [] : content.split(/\n+/);
}

function readBareShallowFile(repoDir: string): string[] {
  const shallowPath = join(repoDir, "shallow");
  if (!existsSync(shallowPath)) {
    return [];
  }

  const content = readFileSync(shallowPath, "utf-8").trim();
  return content.length === 0 ? [] : content.split(/\n+/);
}

async function readLocalTagRefs(workDir: string): Promise<string[]> {
  const output = await gitWithTimeout(["tag", "-l", "--format=%(refname) %(objectname)"], workDir);
  return output.length === 0 ? [] : output.split(/\n+/);
}

async function writeTrackedFile(workDir: string, filename: string, content: string): Promise<void> {
  writeFileSync(join(workDir, filename), content, "utf-8");
  await gitWithTimeout(["add", filename], workDir, GIT_TIMEOUT_MS);
}

async function createFileRepoWithMergeHistory(rootDir: string): Promise<{
  readonly bareDir: string;
  readonly rootCommit: string;
  readonly mainBoundaryCommit: string;
  readonly topicAncestorCommit: string;
  readonly topicBoundaryCommit: string;
  readonly mergeCommit: string;
}> {
  const bareDir = join(rootDir, "server.git");
  const workDir = join(rootDir, "work");

  await gitWithTimeout(["init", "--bare", "-b", "main", bareDir], rootDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(["init", "-b", "main", workDir], rootDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(["remote", "add", "origin", bareDir], workDir, GIT_TIMEOUT_MS);

  await writeTrackedFile(workDir, "root.txt", "root\n");
  await gitWithTimeout(["commit", "-m", "root"], workDir, GIT_TIMEOUT_MS);
  const rootCommit = await gitWithTimeout(["rev-parse", "HEAD"], workDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(["push", "-u", "origin", "main"], workDir, GIT_TIMEOUT_MS);

  await gitWithTimeout(["checkout", "-b", "topic"], workDir, GIT_TIMEOUT_MS);
  await writeTrackedFile(workDir, "topic-ancestor.txt", "topic ancestor\n");
  await gitWithTimeout(["commit", "-m", "topic ancestor"], workDir, GIT_TIMEOUT_MS);
  const topicAncestorCommit = await gitWithTimeout(["rev-parse", "HEAD"], workDir, GIT_TIMEOUT_MS);
  await writeTrackedFile(workDir, "topic-boundary.txt", "topic boundary\n");
  await gitWithTimeout(["commit", "-m", "topic boundary"], workDir, GIT_TIMEOUT_MS);
  const topicBoundaryCommit = await gitWithTimeout(["rev-parse", "HEAD"], workDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(["push", "-u", "origin", "topic"], workDir, GIT_TIMEOUT_MS);

  await gitWithTimeout(["checkout", "main"], workDir, GIT_TIMEOUT_MS);
  await writeTrackedFile(workDir, "main-boundary.txt", "main boundary\n");
  await gitWithTimeout(["commit", "-m", "main boundary"], workDir, GIT_TIMEOUT_MS);
  const mainBoundaryCommit = await gitWithTimeout(["rev-parse", "HEAD"], workDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(["merge", "--no-ff", "topic", "-m", "merge topic"], workDir, GIT_TIMEOUT_MS);
  const mergeCommit = await gitWithTimeout(["rev-parse", "HEAD"], workDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(["push", "origin", "main", "topic"], workDir, GIT_TIMEOUT_MS);

  return {
    bareDir,
    rootCommit,
    mainBoundaryCommit,
    topicAncestorCommit,
    topicBoundaryCommit,
    mergeCommit,
  };
}

async function createFileRepoWithMergeHistoryAndTopicTag(rootDir: string): Promise<{
  readonly bareDir: string;
  readonly rootCommit: string;
  readonly mainBoundaryCommit: string;
  readonly topicAncestorCommit: string;
  readonly topicBoundaryCommit: string;
  readonly mergeCommit: string;
  readonly topicTag: string;
}> {
  const history = await createFileRepoWithMergeHistory(rootDir);
  await gitWithTimeout(
    [
      "--git-dir",
      history.bareDir,
      "tag",
      "-a",
      "tag-topic",
      history.topicBoundaryCommit,
      "-m",
      "tag-topic",
    ],
    rootDir,
    GIT_TIMEOUT_MS,
  );
  const topicTag = await gitWithTimeout(
    ["--git-dir", history.bareDir, "rev-parse", "refs/tags/tag-topic"],
    rootDir,
    GIT_TIMEOUT_MS,
  );
  return { ...history, topicTag };
}

async function createLinearHistoryRepo(rootDir: string): Promise<{
  readonly bareDir: string;
}> {
  const bareDir = join(rootDir, "linear-server.git");
  const workDir = join(rootDir, "linear-work");

  await gitWithTimeout(["init", "--bare", "-b", "main", bareDir], rootDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(["init", "-b", "main", workDir], rootDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(["remote", "add", "origin", bareDir], workDir, GIT_TIMEOUT_MS);

  await writeTrackedFile(workDir, "c1.txt", "c1\n");
  await gitWithTimeout(["commit", "-m", "c1"], workDir, GIT_TIMEOUT_MS);
  await writeTrackedFile(workDir, "c2.txt", "c2\n");
  await gitWithTimeout(["commit", "-m", "c2"], workDir, GIT_TIMEOUT_MS);
  await writeTrackedFile(workDir, "c3.txt", "c3\n");
  await gitWithTimeout(["commit", "-m", "c3"], workDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(["push", "-u", "origin", "main"], workDir, GIT_TIMEOUT_MS);

  return { bareDir };
}

async function cloneAndDeepenMergeRepo(
  url: string,
  targetDir: string,
): Promise<{
  readonly shallowBefore: string[];
  readonly shallowAfter: string[];
  readonly countBefore: string;
  readonly countAfter: string;
}> {
  await gitWithTimeout(
    ["-c", "protocol.version=2", "clone", "--depth=2", url, targetDir],
    dirname(targetDir),
    GIT_TIMEOUT_MS,
  );
  const shallowBefore = readShallowFile(targetDir);
  const countBefore = await gitWithTimeout(
    ["rev-list", "--count", "HEAD"],
    targetDir,
    GIT_TIMEOUT_MS,
  );

  await gitWithTimeout(
    ["-c", "protocol.version=2", "fetch", "--deepen=1", "origin"],
    targetDir,
    GIT_TIMEOUT_MS,
  );
  const shallowAfter = readShallowFile(targetDir);
  const countAfter = await gitWithTimeout(
    ["rev-list", "--count", "HEAD"],
    targetDir,
    GIT_TIMEOUT_MS,
  );

  return { shallowBefore, shallowAfter, countBefore, countAfter };
}

async function cloneDepthTwoThenShallowExcludeTopic(
  url: string,
  targetDir: string,
): Promise<{
  readonly shallowBefore: string[];
  readonly shallowAfter: string[];
  readonly countBefore: string;
  readonly countAfter: string;
}> {
  await gitWithTimeout(
    ["-c", "protocol.version=2", "clone", "--depth=2", url, targetDir],
    dirname(targetDir),
    GIT_TIMEOUT_MS,
  );
  const shallowBefore = readShallowFile(targetDir);
  const countBefore = await gitWithTimeout(
    ["rev-list", "--count", "HEAD"],
    targetDir,
    GIT_TIMEOUT_MS,
  );

  await gitWithTimeout(
    ["-c", "protocol.version=2", "fetch", "--shallow-exclude=topic", "origin"],
    targetDir,
    GIT_TIMEOUT_MS,
  );
  const shallowAfter = readShallowFile(targetDir);
  const countAfter = await gitWithTimeout(
    ["rev-list", "--count", "HEAD"],
    targetDir,
    GIT_TIMEOUT_MS,
  );

  return { shallowBefore, shallowAfter, countBefore, countAfter };
}

async function cloneThenDeepenShallowSource(
  url: string,
  targetDir: string,
): Promise<{
  readonly shallowBefore: string[];
  readonly shallowAfter: string[];
  readonly countBefore: string;
  readonly countAfter: string;
}> {
  await gitWithTimeout(
    ["-c", "protocol.version=2", "clone", url, targetDir],
    dirname(targetDir),
    GIT_TIMEOUT_MS,
  );
  const shallowBefore = readShallowFile(targetDir);
  const countBefore = await gitWithTimeout(
    ["rev-list", "--count", "HEAD"],
    targetDir,
    GIT_TIMEOUT_MS,
  );

  await gitWithTimeout(
    ["-c", "protocol.version=2", "fetch", "--deepen=1", "origin"],
    targetDir,
    GIT_TIMEOUT_MS,
  );
  const shallowAfter = readShallowFile(targetDir);
  const countAfter = await gitWithTimeout(
    ["rev-list", "--count", "HEAD"],
    targetDir,
    GIT_TIMEOUT_MS,
  );

  return { shallowBefore, shallowAfter, countBefore, countAfter };
}

async function cloneShallowSourceDepthOne(
  url: string,
  targetDir: string,
): Promise<{
  readonly shallow: string[];
  readonly count: string;
}> {
  await gitWithTimeout(
    ["-c", "protocol.version=2", "clone", "--depth=1", url, targetDir],
    dirname(targetDir),
    GIT_TIMEOUT_MS,
  );
  return {
    shallow: readShallowFile(targetDir),
    count: await gitWithTimeout(["rev-list", "--count", "HEAD"], targetDir, GIT_TIMEOUT_MS),
  };
}

async function createShallowSourceRepository(rootDir: string): Promise<{
  readonly shallowBareDir: string;
  readonly sourceBoundaryCommit: string;
  readonly tipCommit: string;
}> {
  const upstreamBareDir = join(rootDir, "upstream.git");
  const workDir = join(rootDir, "upstream-work");
  const shallowBareDir = join(rootDir, "shallow-source.git");

  await gitWithTimeout(["init", "--bare", "-b", "main", upstreamBareDir], rootDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(["init", "-b", "main", workDir], rootDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(["remote", "add", "origin", upstreamBareDir], workDir, GIT_TIMEOUT_MS);

  await writeTrackedFile(workDir, "c1.txt", "c1\n");
  await gitWithTimeout(["commit", "-m", "c1"], workDir, GIT_TIMEOUT_MS);
  await writeTrackedFile(workDir, "c2.txt", "c2\n");
  await gitWithTimeout(["commit", "-m", "c2"], workDir, GIT_TIMEOUT_MS);
  await writeTrackedFile(workDir, "c3.txt", "c3\n");
  await gitWithTimeout(["commit", "-m", "c3"], workDir, GIT_TIMEOUT_MS);
  await writeTrackedFile(workDir, "c4.txt", "c4\n");
  await gitWithTimeout(["commit", "-m", "c4"], workDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(["push", "-u", "origin", "main"], workDir, GIT_TIMEOUT_MS);

  await gitWithTimeout(
    ["clone", "--bare", "--depth=2", `file://${upstreamBareDir}`, shallowBareDir],
    rootDir,
    GIT_TIMEOUT_MS,
  );

  const tipCommit = await gitWithTimeout(
    ["--git-dir", shallowBareDir, "rev-parse", "refs/heads/main"],
    rootDir,
    GIT_TIMEOUT_MS,
  );
  const sourceBoundaryCommit = readBareShallowFile(shallowBareDir)[0]!;

  return { shallowBareDir, sourceBoundaryCommit, tipCommit };
}

async function createTaggedShallowSourceRepository(rootDir: string): Promise<{
  readonly shallowBareDir: string;
  readonly sourceBoundaryCommit: string;
  readonly tipCommit: string;
}> {
  const upstreamBareDir = join(rootDir, "tagged-upstream.git");
  const workDir = join(rootDir, "tagged-upstream-work");
  const shallowBareDir = join(rootDir, "tagged-shallow-source.git");

  await gitWithTimeout(["init", "--bare", "-b", "main", upstreamBareDir], rootDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(["init", "-b", "main", workDir], rootDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(["remote", "add", "origin", upstreamBareDir], workDir, GIT_TIMEOUT_MS);

  await writeTrackedFile(workDir, "c1.txt", "c1\n");
  await gitWithTimeout(["commit", "-m", "c1"], workDir, GIT_TIMEOUT_MS);
  await writeTrackedFile(workDir, "c2.txt", "c2\n");
  await gitWithTimeout(["commit", "-m", "c2"], workDir, GIT_TIMEOUT_MS);
  await writeTrackedFile(workDir, "c3.txt", "c3\n");
  await gitWithTimeout(["commit", "-m", "c3"], workDir, GIT_TIMEOUT_MS);
  const sourceBoundaryCommit = await gitWithTimeout(["rev-parse", "HEAD"], workDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(["tag", "tag-c3-light"], workDir, GIT_TIMEOUT_MS);
  await writeTrackedFile(workDir, "c4.txt", "c4\n");
  await gitWithTimeout(["commit", "-m", "c4"], workDir, GIT_TIMEOUT_MS);
  await gitWithTimeout(
    ["push", "-u", "origin", "main", "refs/tags/tag-c3-light"],
    workDir,
    GIT_TIMEOUT_MS,
  );

  await gitWithTimeout(
    ["clone", "--bare", "--depth=2", `file://${upstreamBareDir}`, shallowBareDir],
    rootDir,
    GIT_TIMEOUT_MS,
  );

  const tipCommit = await gitWithTimeout(
    ["--git-dir", shallowBareDir, "rev-parse", "refs/heads/main"],
    rootDir,
    GIT_TIMEOUT_MS,
  );

  return { shallowBareDir, sourceBoundaryCommit, tipCommit };
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

  test("能力广告包含 v2 命令", async () => {
    const transport = createV2HttpTransport(server.url);
    const caps = await transport.advertise();
    const cmdNames = caps.commands.map((c) => c.name);
    expect(cmdNames).toContain("ls-refs");
    expect(cmdNames).toContain("fetch");
    expect(caps.capabilities["object-format"]).toBe("sha1");
    expect(caps.capabilities["server-option"]).toBe(true);
    expect(caps.commands.find((c) => c.name === "ls-refs")?.features).toEqual(["unborn"]);
    expect(caps.commands.find((c) => c.name === "fetch")?.features).toEqual([
      "shallow",
      "wait-for-done",
    ]);
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

    const prepared = await prepareDraft(plan);
    const preview = prepared.preview;
    expect(preview.canApply).toBe(true);

    const result = await prepared.apply();
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
    await applyDraft(plan1);
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

    const preview2 = await previewDraft(plan2);
    expect(preview2.canApply).toBe(true);

    const result2 = await applyDraft(plan2);
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

  test("wait-for-done 协商时服务端不提前发送 ready，直到 done 才返回 packfile", async () => {
    const firstHash = sha1(server.backend.refs.read("refs/heads/main")!);
    const newHash = addCommit(server.backend, firstHash, "wait-for-done");
    server.backend.refs.write("refs/heads/main", newHash);

    const transport = createV2HttpTransport(server.url);
    const caps = await transport.advertise();
    const features = caps.commands.find((c) => c.name === "fetch")?.features ?? [];

    const negotiation = await v2Fetch(
      transport,
      {
        wants: [newHash],
        haves: [firstHash],
        ofsDelta: true,
        waitForDone: true,
        sidebandAll: features.includes("sideband-all"),
      },
      features,
    );
    expect(negotiation.acknowledgments?.acks).toContain(firstHash);
    expect(negotiation.acknowledgments?.ready).not.toBe(true);
    expect(negotiation.packfile).toBeUndefined();

    const pack = await v2Fetch(
      transport,
      {
        wants: [newHash],
        haves: [firstHash],
        ofsDelta: true,
        waitForDone: true,
        sidebandAll: features.includes("sideband-all"),
        done: true,
      },
      features,
    );
    expect(pack.packfile).toBeDefined();
  });

  test("v2 fetch shallow/deepen 会返回正确的 shallow-info", async () => {
    const firstHash = sha1(server.backend.refs.read("refs/heads/main")!);
    const secondHash = addCommit(server.backend, firstHash, "shallow second");
    const thirdHash = addCommit(server.backend, secondHash, "shallow third");
    server.backend.refs.write("refs/heads/main", thirdHash);

    const transport = createV2HttpTransport(server.url);
    const caps = await transport.advertise();
    const features = caps.commands.find((c) => c.name === "fetch")?.features ?? [];

    const shallowClone = await v2Fetch(
      transport,
      {
        wants: [thirdHash],
        ofsDelta: true,
        done: true,
        deepen: 1,
      },
      features,
    );
    expect(shallowClone.shallowInfo).toEqual({
      shallow: [thirdHash],
      unshallow: [],
    });

    const deepened = await v2Fetch(
      transport,
      {
        wants: [thirdHash],
        haves: [thirdHash],
        shallow: [thirdHash],
        ofsDelta: true,
        done: true,
        deepen: 1,
        deepenRelative: true,
      },
      features,
    );
    expect(deepened.shallowInfo).toEqual({
      shallow: [secondHash],
      unshallow: [thirdHash],
    });
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
    const result = await applyDraft(plan);
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

  test("git fetch 同时拉取快进分支与无共同历史的新分支", async () => {
    const target = `${tempDir}/cloned-multi`;

    await gitWithTimeout([...GIT_V2_ARGS, "clone", server.url, target], tempDir, GIT_TIMEOUT_MS);
    const firstHash = sha1(server.backend.refs.read("refs/heads/main")!);

    const newMainHash = addCommit(server.backend, firstHash, "third commit");
    const orphanHash = addRootCommit(server.backend, "orphan root");
    server.backend.refs.write("refs/heads/main", newMainHash);
    server.backend.refs.write("refs/heads/orphan", orphanHash);

    await gitWithTimeout([...GIT_V2_ARGS, "fetch", "origin"], target, GIT_TIMEOUT_MS);

    const remoteMain = await gitWithTimeout(
      [...GIT_V2_ARGS, "rev-parse", "origin/main"],
      target,
      GIT_TIMEOUT_MS,
    );
    const remoteOrphan = await gitWithTimeout(
      [...GIT_V2_ARGS, "rev-parse", "origin/orphan"],
      target,
      GIT_TIMEOUT_MS,
    );
    expect(remoteMain).toBe(newMainHash);
    expect(remoteOrphan).toBe(orphanHash);
  });

  test("git clone --depth=1 后可继续 fetch --deepen=1", async () => {
    const secondHash = addCommit(
      server.backend,
      sha1(server.backend.refs.read("refs/heads/main")!),
      "depth second",
    );
    const thirdHash = addCommit(server.backend, secondHash, "depth third");
    server.backend.refs.write("refs/heads/main", thirdHash);

    const target = `${tempDir}/cloned-shallow`;

    await gitWithTimeout(
      [...GIT_V2_ARGS, "clone", "--depth=1", server.url, target],
      tempDir,
      GIT_TIMEOUT_MS,
    );

    const shallowBefore = await gitWithTimeout(
      [...GIT_V2_ARGS, "rev-list", "--count", "HEAD"],
      target,
      GIT_TIMEOUT_MS,
    );
    expect(shallowBefore).toBe("1");

    await gitWithTimeout([...GIT_V2_ARGS, "fetch", "--deepen=1", "origin"], target, GIT_TIMEOUT_MS);

    const shallowAfter = await gitWithTimeout(
      [...GIT_V2_ARGS, "rev-list", "--count", "HEAD"],
      target,
      GIT_TIMEOUT_MS,
    );
    expect(shallowAfter).toBe("2");
  });
});

describe("Smart HTTP 服务端 — shallow 结果对照", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-server-shallow-compare");
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  test("merge DAG 下 clone --depth=2 后 fetch --deepen=1 的 shallow 结果与 git-http-backend 一致", async () => {
    const history = await createFileRepoWithMergeHistory(tempDir);
    const gitServer = startGitHttpBackendServer(tempDir, "/server.git");
    const nanoServer = startNanoGitServer(createFileRepositoryBackend(history.bareDir));

    try {
      const gitResult = await cloneAndDeepenMergeRepo(gitServer.url, join(tempDir, "git-cli"));
      const nanoResult = await cloneAndDeepenMergeRepo(nanoServer.url, join(tempDir, "nano-cli"));

      expect(nanoResult.countBefore).toBe(gitResult.countBefore);
      expect(nanoResult.countAfter).toBe(gitResult.countAfter);
      expect(nanoResult.shallowBefore).toEqual(gitResult.shallowBefore);
      expect(nanoResult.shallowAfter).toEqual(gitResult.shallowAfter);
      expect(nanoResult.shallowAfter.toSorted()).toEqual(
        [history.rootCommit, history.topicAncestorCommit].toSorted(),
      );
    } finally {
      await gitServer.stop();
      nanoServer.stop();
    }
  });

  test("merge DAG 下 clone --shallow-exclude=topic 的 shallow 结果与 git-http-backend 一致", async () => {
    const history = await createFileRepoWithMergeHistory(tempDir);
    const gitServer = startGitHttpBackendServer(tempDir, "/server.git");
    const nanoServer = startNanoGitServer(createFileRepositoryBackend(history.bareDir));

    try {
      const gitTarget = join(tempDir, "git-shallow-exclude");
      const nanoTarget = join(tempDir, "nano-shallow-exclude");

      await gitWithTimeout(
        ["-c", "protocol.version=2", "clone", "--shallow-exclude=topic", gitServer.url, gitTarget],
        tempDir,
        GIT_TIMEOUT_MS,
      );
      await gitWithTimeout(
        [
          "-c",
          "protocol.version=2",
          "clone",
          "--shallow-exclude=topic",
          nanoServer.url,
          nanoTarget,
        ],
        tempDir,
        GIT_TIMEOUT_MS,
      );

      expect(readShallowFile(nanoTarget)).toEqual(readShallowFile(gitTarget));
      expect(
        await gitWithTimeout(["rev-list", "--count", "HEAD"], nanoTarget, GIT_TIMEOUT_MS),
      ).toBe(await gitWithTimeout(["rev-list", "--count", "HEAD"], gitTarget, GIT_TIMEOUT_MS));
    } finally {
      await gitServer.stop();
      nanoServer.stop();
    }
  });

  test("merge DAG 下 clone --depth=2 后 fetch --shallow-exclude=topic 的 shallow 结果与 git-http-backend 一致", async () => {
    const history = await createFileRepoWithMergeHistory(tempDir);
    const gitServer = startGitHttpBackendServer(tempDir, "/server.git");
    const nanoServer = startNanoGitServer(createFileRepositoryBackend(history.bareDir));

    try {
      const gitResult = await cloneDepthTwoThenShallowExcludeTopic(
        gitServer.url,
        join(tempDir, "git-depth2-exclude-topic"),
      );
      const nanoResult = await cloneDepthTwoThenShallowExcludeTopic(
        nanoServer.url,
        join(tempDir, "nano-depth2-exclude-topic"),
      );

      expect(nanoResult.countBefore).toBe(gitResult.countBefore);
      expect(nanoResult.countAfter).toBe(gitResult.countAfter);
      expect(nanoResult.shallowBefore).toEqual(gitResult.shallowBefore);
      expect(nanoResult.shallowAfter).toEqual(gitResult.shallowAfter);
      expect(nanoResult.shallowAfter.toSorted()).toEqual(
        [history.mainBoundaryCommit, history.topicBoundaryCommit, history.mergeCommit].toSorted(),
      );
    } finally {
      await gitServer.stop();
      nanoServer.stop();
    }
  });

  test("merge DAG 下 clone --depth=2 会带回 reachable annotated tag，与 git-http-backend 一致", async () => {
    const history = await createFileRepoWithMergeHistoryAndTopicTag(tempDir);
    const gitServer = startGitHttpBackendServer(tempDir, "/server.git");
    const nanoServer = startNanoGitServer(createFileRepositoryBackend(history.bareDir));
    const gitTarget = join(tempDir, "git-depth2-tag-clone");
    const nanoTarget = join(tempDir, "nano-depth2-tag-clone");

    try {
      await gitWithTimeout(
        ["-c", "protocol.version=2", "clone", "--depth=2", gitServer.url, gitTarget],
        tempDir,
        GIT_TIMEOUT_MS,
      );
      await gitWithTimeout(
        ["-c", "protocol.version=2", "clone", "--depth=2", nanoServer.url, nanoTarget],
        tempDir,
        GIT_TIMEOUT_MS,
      );

      expect(readShallowFile(nanoTarget)).toEqual(readShallowFile(gitTarget));
      expect(await readLocalTagRefs(nanoTarget)).toEqual(await readLocalTagRefs(gitTarget));
      expect(await readLocalTagRefs(nanoTarget)).toEqual([
        `refs/tags/tag-topic ${history.topicTag}`,
      ]);
    } finally {
      await gitServer.stop();
      nanoServer.stop();
    }
  });

  test("merge DAG 下 clone --depth=2 后 fetch --shallow-exclude=tag-topic 的 shallow 结果与 git-http-backend 一致", async () => {
    const history = await createFileRepoWithMergeHistoryAndTopicTag(tempDir);
    const gitServer = startGitHttpBackendServer(tempDir, "/server.git");
    const nanoServer = startNanoGitServer(createFileRepositoryBackend(history.bareDir));
    const runFetch = async (url: string, targetDir: string) => {
      await gitWithTimeout(
        ["-c", "protocol.version=2", "clone", "--depth=2", url, targetDir],
        tempDir,
        GIT_TIMEOUT_MS,
      );
      const shallowBefore = readShallowFile(targetDir);
      const countBefore = await gitWithTimeout(
        ["rev-list", "--count", "HEAD"],
        targetDir,
        GIT_TIMEOUT_MS,
      );

      await gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--shallow-exclude=tag-topic", "origin"],
        targetDir,
        GIT_TIMEOUT_MS,
      );
      const shallowAfter = readShallowFile(targetDir);
      const countAfter = await gitWithTimeout(
        ["rev-list", "--count", "HEAD"],
        targetDir,
        GIT_TIMEOUT_MS,
      );

      return { shallowBefore, shallowAfter, countBefore, countAfter };
    };

    try {
      const gitResult = await runFetch(
        gitServer.url,
        join(tempDir, "git-depth2-exclude-tag-topic"),
      );
      const nanoResult = await runFetch(
        nanoServer.url,
        join(tempDir, "nano-depth2-exclude-tag-topic"),
      );

      expect(nanoResult.countBefore).toBe(gitResult.countBefore);
      expect(nanoResult.countAfter).toBe(gitResult.countAfter);
      expect(nanoResult.shallowBefore).toEqual(gitResult.shallowBefore);
      expect(nanoResult.shallowAfter).toEqual(gitResult.shallowAfter);
      expect(nanoResult.shallowAfter.toSorted()).toEqual(
        [history.mainBoundaryCommit, history.topicBoundaryCommit, history.mergeCommit].toSorted(),
      );
    } finally {
      await gitServer.stop();
      nanoServer.stop();
    }
  });

  test("merge DAG 下 clone --shallow-exclude=<oid> 时与 git-http-backend 一样拒绝请求", async () => {
    const history = await createFileRepoWithMergeHistory(tempDir);
    const gitServer = startGitHttpBackendServer(tempDir, "/server.git");
    const nanoServer = startNanoGitServer(createFileRepositoryBackend(history.bareDir));
    const gitTarget = join(tempDir, "git-shallow-exclude-oid");
    const nanoTarget = join(tempDir, "nano-shallow-exclude-oid");

    try {
      const gitClone = gitWithTimeout(
        [
          "-c",
          "protocol.version=2",
          "clone",
          `--shallow-exclude=${history.topicBoundaryCommit}`,
          gitServer.url,
          gitTarget,
        ],
        tempDir,
        GIT_TIMEOUT_MS,
      );
      const nanoClone = gitWithTimeout(
        [
          "-c",
          "protocol.version=2",
          "clone",
          `--shallow-exclude=${history.topicBoundaryCommit}`,
          nanoServer.url,
          nanoTarget,
        ],
        tempDir,
        GIT_TIMEOUT_MS,
      );
      const [gitResult, nanoResult] = await Promise.allSettled([gitClone, nanoClone]);
      expect(gitResult.status).toBe("rejected");
      expect(nanoResult.status).toBe("rejected");
      if (gitResult.status === "rejected") {
        expect(String(gitResult.reason)).toContain("HTTP 500");
      }
      if (nanoResult.status === "rejected") {
        expect(String(nanoResult.reason)).toContain("HTTP 500");
      }
    } finally {
      await gitServer.stop();
      nanoServer.stop();
    }
  });

  test("merge DAG 下 clone --branch topic --shallow-exclude=main 时与 git-http-backend 一样拒绝请求", async () => {
    const history = await createFileRepoWithMergeHistory(tempDir);
    const gitServer = startGitHttpBackendServer(tempDir, "/server.git");
    const nanoServer = startNanoGitServer(createFileRepositoryBackend(history.bareDir));
    const gitTarget = join(tempDir, "git-topic-exclude-main");
    const nanoTarget = join(tempDir, "nano-topic-exclude-main");

    try {
      const gitClone = gitWithTimeout(
        [
          "-c",
          "protocol.version=2",
          "clone",
          "--branch",
          "topic",
          "--shallow-exclude=main",
          gitServer.url,
          gitTarget,
        ],
        tempDir,
        GIT_TIMEOUT_MS,
      );
      const nanoClone = gitWithTimeout(
        [
          "-c",
          "protocol.version=2",
          "clone",
          "--branch",
          "topic",
          "--shallow-exclude=main",
          nanoServer.url,
          nanoTarget,
        ],
        tempDir,
        GIT_TIMEOUT_MS,
      );
      const [gitResult, nanoResult] = await Promise.allSettled([gitClone, nanoClone]);
      expect(gitResult.status).toBe("rejected");
      expect(nanoResult.status).toBe("rejected");
      if (gitResult.status === "rejected") {
        expect(String(gitResult.reason)).toContain("HTTP 500");
      }
      if (nanoResult.status === "rejected") {
        expect(String(nanoResult.reason)).toContain("HTTP 500");
      }
    } finally {
      await gitServer.stop();
      nanoServer.stop();
    }
  });

  test("merge DAG 下 shallow topic 后 fetch --shallow-exclude=main 时与 git-http-backend 一样拒绝请求", async () => {
    const history = await createFileRepoWithMergeHistory(tempDir);
    const gitServer = startGitHttpBackendServer(tempDir, "/server.git");
    const nanoServer = startNanoGitServer(createFileRepositoryBackend(history.bareDir));
    const gitTarget = join(tempDir, "git-topic-depth1");
    const nanoTarget = join(tempDir, "nano-topic-depth1");

    try {
      await gitWithTimeout(
        [
          "-c",
          "protocol.version=2",
          "clone",
          "--branch",
          "topic",
          "--depth=1",
          gitServer.url,
          gitTarget,
        ],
        tempDir,
        GIT_TIMEOUT_MS,
      );
      await gitWithTimeout(
        [
          "-c",
          "protocol.version=2",
          "clone",
          "--branch",
          "topic",
          "--depth=1",
          nanoServer.url,
          nanoTarget,
        ],
        tempDir,
        GIT_TIMEOUT_MS,
      );

      const gitFetch = gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--shallow-exclude=main", "origin"],
        gitTarget,
        GIT_TIMEOUT_MS,
      );
      const nanoFetch = gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--shallow-exclude=main", "origin"],
        nanoTarget,
        GIT_TIMEOUT_MS,
      );
      const [gitResult, nanoResult] = await Promise.allSettled([gitFetch, nanoFetch]);
      expect(gitResult.status).toBe("rejected");
      expect(nanoResult.status).toBe("rejected");
      if (gitResult.status === "rejected") {
        expect(String(gitResult.reason)).toContain("HTTP 500");
      }
      if (nanoResult.status === "rejected") {
        expect(String(nanoResult.reason)).toContain("HTTP 500");
      }
    } finally {
      await gitServer.stop();
      nanoServer.stop();
    }
  });

  test("源仓库自身是 shallow 时，clone 结果与 git-http-backend 一致", async () => {
    const history = await createShallowSourceRepository(tempDir);
    const gitServer = startGitHttpBackendServer(tempDir, "/shallow-source.git");
    const nanoServer = startNanoGitServer(createFileRepositoryBackend(history.shallowBareDir));
    const gitTarget = join(tempDir, "git-shallow-source-clone");
    const nanoTarget = join(tempDir, "nano-shallow-source-clone");

    try {
      await gitWithTimeout(
        ["-c", "protocol.version=2", "clone", gitServer.url, gitTarget],
        tempDir,
        GIT_TIMEOUT_MS,
      );
      await gitWithTimeout(
        ["-c", "protocol.version=2", "clone", nanoServer.url, nanoTarget],
        tempDir,
        GIT_TIMEOUT_MS,
      );

      expect(readShallowFile(nanoTarget)).toEqual(readShallowFile(gitTarget));
      expect(readShallowFile(nanoTarget)).toEqual([history.sourceBoundaryCommit]);
      expect(
        await gitWithTimeout(["rev-list", "--count", "HEAD"], nanoTarget, GIT_TIMEOUT_MS),
      ).toBe(await gitWithTimeout(["rev-list", "--count", "HEAD"], gitTarget, GIT_TIMEOUT_MS));
    } finally {
      await gitServer.stop();
      nanoServer.stop();
    }
  });

  test("源仓库自身是 shallow 且 lightweight tag 指向源边界时，clone 原始 shallow 文件与 git-http-backend 一致", async () => {
    const history = await createTaggedShallowSourceRepository(tempDir);
    const gitServer = startGitHttpBackendServer(tempDir, "/tagged-shallow-source.git");
    const nanoServer = startNanoGitServer(createFileRepositoryBackend(history.shallowBareDir));
    const gitTarget = join(tempDir, "git-tagged-shallow-source-clone");
    const nanoTarget = join(tempDir, "nano-tagged-shallow-source-clone");

    try {
      await gitWithTimeout(
        ["-c", "protocol.version=2", "clone", gitServer.url, gitTarget],
        tempDir,
        GIT_TIMEOUT_MS,
      );
      await gitWithTimeout(
        ["-c", "protocol.version=2", "clone", nanoServer.url, nanoTarget],
        tempDir,
        GIT_TIMEOUT_MS,
      );

      expect(readShallowFile(nanoTarget)).toEqual(readShallowFile(gitTarget));
      expect(readShallowFile(nanoTarget)).toEqual([
        history.sourceBoundaryCommit,
        history.sourceBoundaryCommit,
      ]);
      expect(await readLocalTagRefs(nanoTarget)).toEqual(await readLocalTagRefs(gitTarget));
    } finally {
      await gitServer.stop();
      nanoServer.stop();
    }
  });

  test("源仓库自身是 shallow 时，clone 后 fetch --deepen=1 结果与 git-http-backend 一致", async () => {
    const history = await createShallowSourceRepository(tempDir);
    const gitServer = startGitHttpBackendServer(tempDir, "/shallow-source.git");
    const nanoServer = startNanoGitServer(createFileRepositoryBackend(history.shallowBareDir));

    try {
      const gitResult = await cloneThenDeepenShallowSource(
        gitServer.url,
        join(tempDir, "git-shallow-source-deepen"),
      );
      const nanoResult = await cloneThenDeepenShallowSource(
        nanoServer.url,
        join(tempDir, "nano-shallow-source-deepen"),
      );

      expect(nanoResult.countBefore).toBe(gitResult.countBefore);
      expect(nanoResult.countAfter).toBe(gitResult.countAfter);
      expect(nanoResult.shallowBefore).toEqual(gitResult.shallowBefore);
      expect(nanoResult.shallowAfter).toEqual(gitResult.shallowAfter);
      expect(nanoResult.shallowBefore).toEqual([history.sourceBoundaryCommit]);
      expect(nanoResult.shallowAfter).toEqual([history.sourceBoundaryCommit]);
    } finally {
      await gitServer.stop();
      nanoServer.stop();
    }
  });

  test("源仓库自身是 shallow 且 lightweight tag 指向源边界时，clone 后 fetch --deepen=1 会像 git-http-backend 一样去重 shallow 文件", async () => {
    const history = await createTaggedShallowSourceRepository(tempDir);
    const gitServer = startGitHttpBackendServer(tempDir, "/tagged-shallow-source.git");
    const nanoServer = startNanoGitServer(createFileRepositoryBackend(history.shallowBareDir));
    const gitTarget = join(tempDir, "git-tagged-shallow-source-deepen");
    const nanoTarget = join(tempDir, "nano-tagged-shallow-source-deepen");

    try {
      await gitWithTimeout(
        ["-c", "protocol.version=2", "clone", gitServer.url, gitTarget],
        tempDir,
        GIT_TIMEOUT_MS,
      );
      await gitWithTimeout(
        ["-c", "protocol.version=2", "clone", nanoServer.url, nanoTarget],
        tempDir,
        GIT_TIMEOUT_MS,
      );
      await gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--deepen=1", "origin"],
        gitTarget,
        GIT_TIMEOUT_MS,
      );
      await gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--deepen=1", "origin"],
        nanoTarget,
        GIT_TIMEOUT_MS,
      );

      expect(readShallowFile(nanoTarget)).toEqual(readShallowFile(gitTarget));
      expect(readShallowFile(nanoTarget)).toEqual([history.sourceBoundaryCommit]);
      expect(await readLocalTagRefs(nanoTarget)).toEqual(await readLocalTagRefs(gitTarget));
    } finally {
      await gitServer.stop();
      nanoServer.stop();
    }
  });

  test("源仓库自身是 shallow 时，clone --depth=1 结果与 git-http-backend 一致", async () => {
    const history = await createShallowSourceRepository(tempDir);
    const gitServer = startGitHttpBackendServer(tempDir, "/shallow-source.git");
    const nanoServer = startNanoGitServer(createFileRepositoryBackend(history.shallowBareDir));

    try {
      const gitResult = await cloneShallowSourceDepthOne(
        gitServer.url,
        join(tempDir, "git-shallow-source-depth1"),
      );
      const nanoResult = await cloneShallowSourceDepthOne(
        nanoServer.url,
        join(tempDir, "nano-shallow-source-depth1"),
      );

      expect(nanoResult.count).toBe(gitResult.count);
      expect(nanoResult.shallow).toEqual(gitResult.shallow);
      expect(nanoResult.shallow).toEqual([history.tipCommit]);
    } finally {
      await gitServer.stop();
      nanoServer.stop();
    }
  });

  test("源仓库自身是 shallow 时，clone 后 fetch --shallow-since=1970-01-01 与 git-http-backend 一样拒绝请求", async () => {
    const history = await createShallowSourceRepository(tempDir);
    const gitServer = startGitHttpBackendServer(tempDir, "/shallow-source.git");
    const nanoServer = startNanoGitServer(createFileRepositoryBackend(history.shallowBareDir));
    const gitTarget = join(tempDir, "git-shallow-source-since");
    const nanoTarget = join(tempDir, "nano-shallow-source-since");

    try {
      await gitWithTimeout(
        ["-c", "protocol.version=2", "clone", gitServer.url, gitTarget],
        tempDir,
        GIT_TIMEOUT_MS,
      );
      await gitWithTimeout(
        ["-c", "protocol.version=2", "clone", nanoServer.url, nanoTarget],
        tempDir,
        GIT_TIMEOUT_MS,
      );

      const gitFetch = gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--shallow-since=1970-01-01", "origin"],
        gitTarget,
        GIT_TIMEOUT_MS,
      );
      const nanoFetch = gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--shallow-since=1970-01-01", "origin"],
        nanoTarget,
        GIT_TIMEOUT_MS,
      );
      const [gitResult, nanoResult] = await Promise.allSettled([gitFetch, nanoFetch]);
      expect(gitResult.status).toBe("rejected");
      expect(nanoResult.status).toBe("rejected");
      if (gitResult.status === "rejected") {
        expect(String(gitResult.reason)).toContain("HTTP 500");
      }
      if (nanoResult.status === "rejected") {
        expect(String(nanoResult.reason)).toContain("HTTP 500");
      }
    } finally {
      await gitServer.stop();
      nanoServer.stop();
    }
  });

  test("depth=1 后 fetch --shallow-since=未来时间 时与 git-http-backend 一样拒绝请求", async () => {
    const history = await createLinearHistoryRepo(tempDir);
    const gitServer = startGitHttpBackendServer(tempDir, "/linear-server.git");
    const nanoServer = startNanoGitServer(createFileRepositoryBackend(history.bareDir));
    const gitTarget = join(tempDir, "git-linear-shallow-since-future");
    const nanoTarget = join(tempDir, "nano-linear-shallow-since-future");

    try {
      await gitWithTimeout(
        ["-c", "protocol.version=2", "clone", "--depth=1", gitServer.url, gitTarget],
        tempDir,
        GIT_TIMEOUT_MS,
      );
      await gitWithTimeout(
        ["-c", "protocol.version=2", "clone", "--depth=1", nanoServer.url, nanoTarget],
        tempDir,
        GIT_TIMEOUT_MS,
      );

      const gitFetch = gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--shallow-since=2100-01-01", "origin"],
        gitTarget,
        GIT_TIMEOUT_MS,
      );
      const nanoFetch = gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", "--shallow-since=2100-01-01", "origin"],
        nanoTarget,
        GIT_TIMEOUT_MS,
      );
      const [gitResult, nanoResult] = await Promise.allSettled([gitFetch, nanoFetch]);
      expect(gitResult.status).toBe("rejected");
      expect(nanoResult.status).toBe("rejected");
      if (gitResult.status === "rejected") {
        expect(String(gitResult.reason)).toContain("HTTP 500");
      }
      if (nanoResult.status === "rejected") {
        expect(String(nanoResult.reason)).toContain("HTTP 500");
      }
    } finally {
      await gitServer.stop();
      nanoServer.stop();
    }
  });
});
