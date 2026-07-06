/**
 * Import Session 端到端测试
 *
 * 通过真实 git-http-backend 验证 advertisement、对象导入、
 * ref/HEAD 物化、ownership/prune 与前置条件漂移语义。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  cleanupDir,
  createFile,
  createTempDir,
  git,
  gitFsck,
  gitRevParse,
  gitWithTimeout,
} from "../helpers.ts";
import { createServerRepo } from "./helpers.ts";
import { getNormalizedFetchCommandBatches } from "./helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { initRepository } from "@/repository/file.ts";
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

function readShallowFile(workDir: string): string[] {
  const shallowPath = join(workDir, ".git", "shallow");
  if (!existsSync(shallowPath)) {
    return [];
  }

  const content = readFileSync(shallowPath, "utf-8").trim();
  return content.length === 0 ? [] : content.split(/\n+/);
}

function readBareShallowFile(gitDir: string): string[] {
  const shallowPath = join(gitDir, "shallow");
  if (!existsSync(shallowPath)) {
    return [];
  }

  const content = readFileSync(shallowPath, "utf-8").trim();
  return content.length === 0 ? [] : content.split(/\n+/);
}

function sortHashes(hashes: readonly string[]): string[] {
  return [...hashes].sort();
}

function sortUniqueHashes(hashes: readonly string[]): string[] {
  return [...new Set(hashes)].sort();
}

function getHaveLines(batch: readonly string[]): string[] {
  return batch.filter((line) => line.startsWith("have "));
}

function getNonHaveLines(batch: readonly string[]): string[] {
  return batch.filter((line) => !line.startsWith("have "));
}

async function createTaggedShallowSourceRepository(
  rootDir: string,
  options: {
    readonly annotated?: boolean;
    readonly repoName: string;
    readonly upstreamName: string;
    readonly workName: string;
    readonly tagName: string;
  },
): Promise<{
  readonly shallowBareDir: string;
  readonly sourceBoundaryCommit: string;
  readonly tipCommit: string;
}> {
  const upstreamBareDir = join(rootDir, options.upstreamName);
  const workDir = join(rootDir, options.workName);
  const shallowBareDir = join(rootDir, options.repoName);

  git(["init", "--bare", "-b", "main", upstreamBareDir], rootDir);
  git(["init", "-b", "main", workDir], rootDir);
  git(["remote", "add", "origin", upstreamBareDir], workDir);

  createFile(workDir, "c1.txt", "c1\n");
  git(["add", "c1.txt"], workDir);
  git(["commit", "-m", "c1"], workDir);
  createFile(workDir, "c2.txt", "c2\n");
  git(["add", "c2.txt"], workDir);
  git(["commit", "-m", "c2"], workDir);
  createFile(workDir, "c3.txt", "c3\n");
  git(["add", "c3.txt"], workDir);
  git(["commit", "-m", "c3"], workDir);
  const sourceBoundaryCommit = sha1(git(["rev-parse", "HEAD"], workDir));

  if (options.annotated) {
    git(["tag", "-a", options.tagName, "-m", options.tagName], workDir);
  } else {
    git(["tag", options.tagName], workDir);
  }

  createFile(workDir, "c4.txt", "c4\n");
  git(["add", "c4.txt"], workDir);
  git(["commit", "-m", "c4"], workDir);
  git(["push", "-u", "origin", "main", `refs/tags/${options.tagName}`], workDir);
  git(["clone", "--bare", "--depth=2", `file://${upstreamBareDir}`, shallowBareDir], rootDir);

  const tipCommit = sha1(
    git(["--git-dir", shallowBareDir, "rev-parse", "refs/heads/main"], rootDir),
  );
  return { shallowBareDir, sourceBoundaryCommit, tipCommit };
}

async function createShallowSourceRepository(
  rootDir: string,
  options: {
    readonly repoName: string;
    readonly upstreamName: string;
    readonly workName: string;
  },
): Promise<{
  readonly shallowBareDir: string;
  readonly sourceBoundaryCommit: string;
  readonly tipCommit: string;
}> {
  const upstreamBareDir = join(rootDir, options.upstreamName);
  const workDir = join(rootDir, options.workName);
  const shallowBareDir = join(rootDir, options.repoName);

  git(["init", "--bare", "-b", "main", upstreamBareDir], rootDir);
  git(["init", "-b", "main", workDir], rootDir);
  git(["remote", "add", "origin", upstreamBareDir], workDir);

  createFile(workDir, "c1.txt", "c1\n");
  git(["add", "c1.txt"], workDir);
  git(["commit", "-m", "c1"], workDir);
  createFile(workDir, "c2.txt", "c2\n");
  git(["add", "c2.txt"], workDir);
  git(["commit", "-m", "c2"], workDir);
  createFile(workDir, "c3.txt", "c3\n");
  git(["add", "c3.txt"], workDir);
  git(["commit", "-m", "c3"], workDir);
  const sourceBoundaryCommit = sha1(git(["rev-parse", "HEAD"], workDir));
  createFile(workDir, "c4.txt", "c4\n");
  git(["add", "c4.txt"], workDir);
  git(["commit", "-m", "c4"], workDir);
  git(["push", "-u", "origin", "main"], workDir);
  git(["clone", "--bare", "--depth=2", `file://${upstreamBareDir}`, shallowBareDir], rootDir);

  const tipCommit = sha1(
    git(["--git-dir", shallowBareDir, "rev-parse", "refs/heads/main"], rootDir),
  );
  return { shallowBareDir, sourceBoundaryCommit, tipCommit };
}

async function createMergeShallowSourceRepository(
  rootDir: string,
  options: {
    readonly repoName: string;
    readonly upstreamName: string;
    readonly workName: string;
  },
): Promise<{
  readonly shallowBareDir: string;
  readonly tipCommit: string;
  readonly mergeCommit: string;
  readonly topicBoundaryCommit: string;
  readonly mainBoundaryCommit: string;
}> {
  const upstreamBareDir = join(rootDir, options.upstreamName);
  const workDir = join(rootDir, options.workName);
  const shallowBareDir = join(rootDir, options.repoName);

  git(["init", "--bare", "-b", "main", upstreamBareDir], rootDir);
  git(["init", "-b", "main", workDir], rootDir);
  git(["remote", "add", "origin", upstreamBareDir], workDir);

  for (const name of ["base-1", "base-2", "base-3"]) {
    createFile(workDir, `${name}.txt`, `${name}\n`);
    git(["add", `${name}.txt`], workDir);
    git(["commit", "-m", name], workDir);
  }

  git(["checkout", "-b", "topic", "main~1"], workDir);
  for (const name of ["topic-1", "topic-2"]) {
    createFile(workDir, `${name}.txt`, `${name}\n`);
    git(["add", `${name}.txt`], workDir);
    git(["commit", "-m", name], workDir);
  }
  const topicBoundaryCommit = sha1(git(["rev-parse", "HEAD"], workDir));

  git(["checkout", "main"], workDir);
  createFile(workDir, "main-advance-1.txt", "main-advance-1\n");
  git(["add", "main-advance-1.txt"], workDir);
  git(["commit", "-m", "main-advance-1"], workDir);
  const mainBoundaryCommit = sha1(git(["rev-parse", "HEAD"], workDir));

  git(["merge", "--no-ff", "topic", "-m", "merge-topic"], workDir);
  const mergeCommit = sha1(git(["rev-parse", "HEAD"], workDir));

  createFile(workDir, "tail-after-merge.txt", "tail-after-merge\n");
  git(["add", "tail-after-merge.txt"], workDir);
  git(["commit", "-m", "tail-after-merge"], workDir);
  git(["push", "-u", "origin", "main", "topic"], workDir);
  git(["clone", "--bare", "--depth=3", `file://${upstreamBareDir}`, shallowBareDir], rootDir);

  const shallowEntries = sortHashes(readBareShallowFile(shallowBareDir));
  expect(shallowEntries).toEqual(sortHashes([topicBoundaryCommit, mainBoundaryCommit]));

  const tipCommit = sha1(
    git(["--git-dir", shallowBareDir, "rev-parse", "refs/heads/main"], rootDir),
  );
  return {
    shallowBareDir,
    tipCommit,
    mergeCommit,
    topicBoundaryCommit,
    mainBoundaryCommit,
  };
}

async function createTaggedMergeShallowSourceRepository(
  rootDir: string,
  options: {
    readonly annotated?: boolean;
    readonly repoName: string;
    readonly upstreamName: string;
    readonly workName: string;
    readonly tagName: string;
    readonly tagTarget: "main-boundary" | "topic-boundary";
  },
): Promise<{
  readonly shallowBareDir: string;
  readonly tipCommit: string;
  readonly mergeCommit: string;
  readonly topicBoundaryCommit: string;
  readonly mainBoundaryCommit: string;
  readonly tagHash: string;
}> {
  const upstreamBareDir = join(rootDir, options.upstreamName);
  const workDir = join(rootDir, options.workName);
  const shallowBareDir = join(rootDir, options.repoName);

  git(["init", "--bare", "-b", "main", upstreamBareDir], rootDir);
  git(["init", "-b", "main", workDir], rootDir);
  git(["remote", "add", "origin", upstreamBareDir], workDir);

  for (const name of ["base-1", "base-2", "base-3"]) {
    createFile(workDir, `${name}.txt`, `${name}\n`);
    git(["add", `${name}.txt`], workDir);
    git(["commit", "-m", name], workDir);
  }

  git(["checkout", "-b", "topic", "main~1"], workDir);
  for (const name of ["topic-1", "topic-2"]) {
    createFile(workDir, `${name}.txt`, `${name}\n`);
    git(["add", `${name}.txt`], workDir);
    git(["commit", "-m", name], workDir);
  }
  const topicBoundaryCommit = sha1(git(["rev-parse", "HEAD"], workDir));

  git(["checkout", "main"], workDir);
  createFile(workDir, "main-advance-1.txt", "main-advance-1\n");
  git(["add", "main-advance-1.txt"], workDir);
  git(["commit", "-m", "main-advance-1"], workDir);
  const mainBoundaryCommit = sha1(git(["rev-parse", "HEAD"], workDir));

  const tagTarget =
    options.tagTarget === "topic-boundary" ? topicBoundaryCommit : mainBoundaryCommit;
  if (options.annotated) {
    git(["tag", "-a", options.tagName, tagTarget, "-m", options.tagName], workDir);
  } else {
    git(["tag", options.tagName, tagTarget], workDir);
  }
  const tagHash = sha1(git(["rev-parse", `refs/tags/${options.tagName}`], workDir));

  git(["merge", "--no-ff", "topic", "-m", "merge-topic"], workDir);
  const mergeCommit = sha1(git(["rev-parse", "HEAD"], workDir));

  createFile(workDir, "tail-after-merge.txt", "tail-after-merge\n");
  git(["add", "tail-after-merge.txt"], workDir);
  git(["commit", "-m", "tail-after-merge"], workDir);
  git(["push", "-u", "origin", "main", "topic", `refs/tags/${options.tagName}`], workDir);
  git(["clone", "--bare", "--depth=3", `file://${upstreamBareDir}`, shallowBareDir], rootDir);

  const shallowEntries = sortHashes(readBareShallowFile(shallowBareDir));
  expect(shallowEntries).toEqual(sortHashes([topicBoundaryCommit, mainBoundaryCommit]));

  const tipCommit = sha1(
    git(["--git-dir", shallowBareDir, "rev-parse", "refs/heads/main"], rootDir),
  );
  return {
    shallowBareDir,
    tipCommit,
    mergeCommit,
    topicBoundaryCommit,
    mainBoundaryCommit,
    tagHash,
  };
}

describe("Import Session", () => {
  let tempDir: string;
  let localDir: string;
  let repoDir: string;
  let workDir: string;
  let mainCommitHash: ReturnType<typeof sha1>;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(async () => {
    tempDir = createTempDir("e2e-http-import-session");
    localDir = join(tempDir, "local");

    const serverRepo = createServerRepo(tempDir, "server.git");
    repoDir = serverRepo.repoDir;
    workDir = serverRepo.workDir;
    mainCommitHash = sha1(serverRepo.commitHash);

    server = startGitHttpBackendServer(tempDir, "/server.git");
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("远端默认分支可物化为本地分支并设置 HEAD", async () => {
    const repo = initRepository(localDir);
    const session = await repo.openImportSession({ url: server.url });
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
    expect(preview.prefetchedObjects).toBeGreaterThan(0);

    const result = await prepared.apply();

    expect(result.updatedRefs.get("refs/heads/main")).toBe(mainCommitHash);
    expect(result.importedObjects).toBe(preview.prefetchedObjects);
    expect(result.headTarget).toBe("refs/heads/main");
    expect(repo.refs.read("HEAD")).toBe("ref: refs/heads/main");
    expect(repo.readRef("HEAD")).toBe(mainCommitHash);
    expect(gitRevParse(localDir, "HEAD")).toBe(mainCommitHash);

    const fsckOutput = gitFsck(localDir);
    expect(fsckOutput).not.toContain("error");
    expect(fsckOutput).not.toContain("broken");
  });

  test("repo.fetch({ depth / deepen }) 会对齐 shallow 请求语义并持久化边界", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    const secondCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    createFile(workDir, "third.txt", "third\n");
    git(["add", "third.txt"], workDir);
    git(["commit", "-m", "Third commit"], workDir);
    const thirdCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    const repo = initRepository(localDir);

    server.clearRequests();
    const firstResult = await repo.fetch(server.url, { depth: 1 });

    expect(firstResult.objectCount).toBeGreaterThan(0);
    expect(repo.readBranch("main")).toBe(thirdCommitHash);
    expect(repo.shallow.read()).toEqual([thirdCommitHash]);
    expect(getNormalizedFetchCommandBatches(server.requests)).toEqual([
      [
        "command=fetch",
        "object-format=sha1",
        "thin-pack",
        "no-progress",
        "include-tag",
        "ofs-delta",
        "deepen 1",
        `want ${thirdCommitHash}`,
        "done",
      ],
    ]);

    server.clearRequests();
    const secondResult = await repo.fetch(server.url, { deepen: 1 });

    expect(secondResult.objectCount).toBeGreaterThan(0);
    expect(repo.readBranch("main")).toBe(thirdCommitHash);
    expect(repo.shallow.read()).toEqual([secondCommitHash]);
    expect(getNormalizedFetchCommandBatches(server.requests)).toEqual([
      [
        "command=fetch",
        "object-format=sha1",
        "thin-pack",
        "no-progress",
        "include-tag",
        "ofs-delta",
        `shallow ${thirdCommitHash}`,
        "deepen 1",
        "deepen-relative",
        `want ${thirdCommitHash}`,
        `have ${thirdCommitHash}`,
      ],
    ]);
  });

  test("repo.fetch({ unshallow: true }) 会像 git fetch --unshallow 一样补齐历史并清空 shallow", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    createFile(workDir, "third.txt", "third\n");
    git(["add", "third.txt"], workDir);
    git(["commit", "-m", "Third commit"], workDir);
    const thirdCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    const cliDir = join(tempDir, "cli-unshallow");
    const repo = initRepository(join(tempDir, "nano-unshallow"));

    await gitWithTimeout(
      ["-c", "protocol.version=2", "clone", "--depth=1", server.url, cliDir],
      tempDir,
      15000,
    );
    await repo.fetch(server.url, { depth: 1 });

    expect(readShallowFile(cliDir)).toEqual([thirdCommitHash]);
    expect(repo.shallow.read()).toEqual([thirdCommitHash]);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { unshallow: true });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--unshallow", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThan(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.readBranch("main")).toBe(thirdCommitHash);
    expect(repo.shallow.read()).toEqual([]);
    expect(readShallowFile(cliDir)).toEqual([]);
  });

  test("完整仓库上 repo.fetch({ deepen: 1 }) 会像 git CLI 一样继续发送祖先 have 且保持 no-op", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    createFile(workDir, "third.txt", "third\n");
    git(["add", "third.txt"], workDir);
    git(["commit", "-m", "Third commit"], workDir);
    const thirdCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    const cliDir = join(tempDir, "cli-complete-deepen");
    const repo = initRepository(join(tempDir, "nano-complete-deepen"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { deepen: 1 });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--deepen=1", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBe(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    expect(nanoBatches[0]).toContain("deepen 1");
    expect(nanoBatches[0]).toContain("deepen-relative");
    expect(nanoBatches[0]).toContain(`want ${thirdCommitHash}`);
    expect(nanoBatches[0]?.filter((line) => line.startsWith("have ")).length).toBeGreaterThan(1);
  });

  test("完整仓库上 repo.fetch({ depth: 1 }) 会像 git CLI 一样发送祖先 have 并收缩为 depth=1", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    createFile(workDir, "third.txt", "third\n");
    git(["add", "third.txt"], workDir);
    git(["commit", "-m", "Third commit"], workDir);
    createFile(workDir, "fourth.txt", "fourth\n");
    git(["add", "fourth.txt"], workDir);
    git(["commit", "-m", "Fourth commit"], workDir);
    const fourthCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    const cliDir = join(tempDir, "cli-complete-depth1");
    const repo = initRepository(join(tempDir, "nano-complete-depth1"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { depth: 1 });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--depth=1", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBe(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    expect(nanoBatches[0]).toContain("deepen 1");
    expect(nanoBatches[0]).toContain(`want ${fourthCommitHash}`);
    expect(nanoBatches[0]?.filter((line) => line.startsWith("have ")).length).toBeGreaterThan(1);
    expect(repo.shallow.read()).toEqual([fourthCommitHash]);
    expect(readShallowFile(cliDir)).toEqual([fourthCommitHash]);
  });

  test("repo.fetch({ noTags: true }) 会像 git CLI 一样关闭 include-tag 且不导入标签", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    git(["tag", "-a", "v1.0.0", "-m", "v1.0.0"], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v1.0.0"], workDir);

    const repo = initRepository(localDir);
    const cliDir = join(tempDir, "cli-no-tags");

    await repo.fetch(server.url, { noTags: true });
    await gitWithTimeout(
      ["-c", "protocol.version=2", "clone", "--no-tags", server.url, cliDir],
      tempDir,
      15000,
    );

    createFile(workDir, "third.txt", "third\n");
    git(["add", "third.txt"], workDir);
    git(["commit", "-m", "Third commit"], workDir);
    const thirdCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "-a", "v2.0.0", "-m", "v2.0.0"], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2.0.0"], workDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { noTags: true });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--no-tags", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThan(0);
    expect(repo.readBranch("main")).toBe(thirdCommitHash);
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches[0]).not.toContain("include-tag");
    expect(git(["tag", "-l"], cliDir)).toBe("");
  });

  test("空仓库首次 repo.fetch() 会像 git clone 一样带回可达 annotated tag", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "tagged.txt", "tagged\n");
    git(["add", "tagged.txt"], workDir);
    git(["commit", "-m", "Tagged commit"], workDir);
    const taggedCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "-a", "v1.0.0", "-m", "v1.0.0"], workDir);
    const tagHash = git(["rev-parse", "refs/tags/v1.0.0"], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v1.0.0"], workDir);

    const repo = initRepository(localDir);
    const cliDir = join(tempDir, "cli-default-tags");

    await repo.fetch(server.url);
    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);

    expect(repo.readBranch("main")).toBe(taggedCommitHash);
    expect(repo.refs.read("refs/tags/v1.0.0")).toBe(sha1(tagHash));
    expect(repo.refs.list("refs/tags/")).toEqual(["refs/tags/v1.0.0"]);
    expect(git(["tag", "-l"], cliDir)).toBe("v1.0.0");
  });

  test("非 shallow 已有仓库后续 repo.fetch() 会像 git fetch 一样自动物化新增可达 tag", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "first-tagged.txt", "first-tagged\n");
    git(["add", "first-tagged.txt"], workDir);
    git(["commit", "-m", "First tagged commit"], workDir);
    git(["tag", "-a", "v1.0.0", "-m", "v1.0.0"], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v1.0.0"], workDir);

    const repo = initRepository(localDir);
    const cliDir = join(tempDir, "cli-followup-default-tags");

    await repo.fetch(server.url);
    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);

    createFile(workDir, "second-tagged.txt", "second-tagged\n");
    git(["add", "second-tagged.txt"], workDir);
    git(["commit", "-m", "Second tagged commit"], workDir);
    const secondTaggedCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "-a", "v2.0.0", "-m", "v2.0.0"], workDir);
    const secondTagHash = sha1(git(["rev-parse", "refs/tags/v2.0.0"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2.0.0"], workDir);

    server.clearRequests();
    await repo.fetch(server.url);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(["-c", "protocol.version=2", "fetch", "origin"], cliDir, 15000);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.readBranch("main")).toBe(secondTaggedCommitHash);
    expect(repo.refs.read("refs/tags/v2.0.0")).toBe(secondTagHash);
    expect(repo.refs.list("refs/tags/")).toEqual(["refs/tags/v1.0.0", "refs/tags/v2.0.0"]);
    expect(git(["tag", "-l"], cliDir).split("\n").filter(Boolean).sort()).toEqual([
      "v1.0.0",
      "v2.0.0",
    ]);
  });

  test("默认 repo.fetch() 对已可达旧提交上的新增 annotated tag 会像 git fetch 一样单独抓取 tag 对象", async () => {
    const repo = initRepository(localDir);
    const cliDir = join(tempDir, "cli-default-annotated-old-tag");

    await repo.fetch(server.url);
    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);

    const firstCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "-a", "v1.0.0", "-m", "v1.0.0", firstCommitHash], workDir);
    const tagHash = sha1(git(["rev-parse", "refs/tags/v1.0.0"], workDir));
    git(["push", repoDir, "refs/tags/v1.0.0"], workDir);

    server.clearRequests();
    await repo.fetch(server.url);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(["-c", "protocol.version=2", "fetch", "origin"], cliDir, 15000);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toEqual([
      [
        "command=fetch",
        "object-format=sha1",
        "thin-pack",
        "no-progress",
        "include-tag",
        "ofs-delta",
        `want ${tagHash}`,
        `have ${firstCommitHash}`,
      ],
    ]);
    expect(repo.refs.read("refs/tags/v1.0.0")).toBe(tagHash);
    expect(git(["tag", "-l"], cliDir)).toBe("v1.0.0");
  });

  test("默认 repo.fetch() 对已可达旧提交上的新增 lightweight tag 会像 git fetch 一样只更新 refs 不抓对象", async () => {
    const repo = initRepository(localDir);
    const cliDir = join(tempDir, "cli-default-lightweight-old-tag");

    await repo.fetch(server.url);
    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);

    const firstCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "v1.0.0", firstCommitHash], workDir);
    git(["push", repoDir, "refs/tags/v1.0.0"], workDir);

    server.clearRequests();
    await repo.fetch(server.url);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(["-c", "protocol.version=2", "fetch", "origin"], cliDir, 15000);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toEqual([]);
    expect(repo.refs.read("refs/tags/v1.0.0")).toBe(firstCommitHash);
    expect(git(["tag", "-l"], cliDir)).toBe("v1.0.0");
  });

  test("默认 repo.fetch() 对新分支 tip 上新增 lightweight tag 会像 git fetch 一样重复 want 对应提交", async () => {
    const repo = initRepository(localDir);
    const cliDir = join(tempDir, "cli-default-lightweight-tip-tag");

    await repo.fetch(server.url);
    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);

    git(["checkout", "main"], workDir);
    createFile(workDir, "tip-tagged.txt", "tip-tagged\n");
    git(["add", "tip-tagged.txt"], workDir);
    git(["commit", "-m", "Tip tagged commit"], workDir);
    const taggedCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "v1.0.0"], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v1.0.0"], workDir);

    server.clearRequests();
    await repo.fetch(server.url);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(["-c", "protocol.version=2", "fetch", "origin"], cliDir, 15000);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toEqual([
      [
        "command=fetch",
        "object-format=sha1",
        "thin-pack",
        "no-progress",
        "include-tag",
        "ofs-delta",
        `want ${taggedCommitHash}`,
        `want ${taggedCommitHash}`,
        `have ${mainCommitHash}`,
      ],
    ]);
    expect(repo.refs.read("refs/tags/v1.0.0")).toBe(taggedCommitHash);
    expect(git(["tag", "-l"], cliDir)).toBe("v1.0.0");
  });

  test("默认 repo.fetch() 的 full follow-up 会像 git fetch 一样单轮完成并只对必要 tag 对象保留显式 want", async () => {
    const repo = initRepository(localDir);
    const cliDir = join(tempDir, "cli-default-followup-single-round");

    await repo.fetch(server.url);
    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);

    git(["checkout", "main"], workDir);
    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    createFile(workDir, "d.txt", "D\n");
    git(["add", "d.txt"], workDir);
    git(["commit", "-m", "D"], workDir);
    const branchAnchorHash = sha1(git(["rev-parse", "HEAD~2"], workDir));
    const middleTagTargetHash = sha1(git(["rev-parse", "HEAD~1"], workDir));
    const topTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    git(["checkout", "-b", "old", branchAnchorHash], workDir);
    git(["push", repoDir, "old"], workDir);
    git(["checkout", "main"], workDir);

    git(["tag", "t-b", branchAnchorHash], workDir);
    git(["tag", "t-c", middleTagTargetHash], workDir);
    git(["tag", "-a", "t-d", "-m", "t-d", topTagTargetHash], workDir);
    const topAnnotatedTagHash = sha1(git(["rev-parse", "refs/tags/t-d"], workDir));
    git(["push", repoDir, "refs/tags/t-b"], workDir);
    git(["push", repoDir, "refs/tags/t-c"], workDir);
    git(["push", repoDir, "refs/tags/t-d"], workDir);

    server.clearRequests();
    await repo.fetch(server.url);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(["-c", "protocol.version=2", "fetch", "origin"], cliDir, 15000);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    expect(nanoBatches[0]).toContain("include-tag");
    expect(nanoBatches[0]).toContain(`want ${topTagTargetHash}`);
    expect(nanoBatches[0]).toContain(`want ${branchAnchorHash}`);
    expect(nanoBatches[0]).toContain(`want ${topAnnotatedTagHash}`);
    expect(nanoBatches[0]).toContain(`have ${mainCommitHash}`);
    expect(nanoBatches[0]).not.toContain(`want ${middleTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain("done");
    expect(repo.readBranch("main")).toBe(topTagTargetHash);
    expect(repo.readBranch("old")).toBe(branchAnchorHash);
    expect(git(["tag", "-l"], cliDir).split("\n").filter(Boolean).sort()).toEqual([
      "t-b",
      "t-c",
      "t-d",
    ]);
  });

  test("默认 repo.fetch({ noTags: true }) 的 full follow-up 会像 git fetch --no-tags 一样单轮完成且忽略 tag want", async () => {
    const repo = initRepository(localDir);
    const cliDir = join(tempDir, "cli-default-followup-no-tags-single-round");

    await repo.fetch(server.url, { noTags: true });
    await gitWithTimeout(
      ["-c", "protocol.version=2", "clone", "--no-tags", server.url, cliDir],
      tempDir,
      15000,
    );

    git(["checkout", "main"], workDir);
    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    createFile(workDir, "d.txt", "D\n");
    git(["add", "d.txt"], workDir);
    git(["commit", "-m", "D"], workDir);
    const branchAnchorHash = sha1(git(["rev-parse", "HEAD~2"], workDir));
    const middleTagTargetHash = sha1(git(["rev-parse", "HEAD~1"], workDir));
    const topTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    git(["checkout", "-b", "old", branchAnchorHash], workDir);
    git(["push", repoDir, "old"], workDir);
    git(["checkout", "main"], workDir);

    git(["tag", "t-b", branchAnchorHash], workDir);
    git(["tag", "t-c", middleTagTargetHash], workDir);
    git(["tag", "-a", "t-d", "-m", "t-d", topTagTargetHash], workDir);
    git(["push", repoDir, "refs/tags/t-b"], workDir);
    git(["push", repoDir, "refs/tags/t-c"], workDir);
    git(["push", repoDir, "refs/tags/t-d"], workDir);

    server.clearRequests();
    await repo.fetch(server.url, { noTags: true });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--no-tags", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    expect(nanoBatches[0]).not.toContain("include-tag");
    expect(nanoBatches[0]).toContain(`want ${topTagTargetHash}`);
    expect(nanoBatches[0]).toContain(`want ${branchAnchorHash}`);
    expect(nanoBatches[0]).toContain(`have ${mainCommitHash}`);
    expect(nanoBatches[0]).not.toContain(`want ${middleTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain("done");
    expect(repo.readBranch("main")).toBe(topTagTargetHash);
    expect(repo.readBranch("old")).toBe(branchAnchorHash);
    expect(repo.refs.read("refs/tags/t-b")).toBeNull();
    expect(repo.refs.read("refs/tags/t-c")).toBeNull();
    expect(repo.refs.read("refs/tags/t-d")).toBeNull();
    expect(git(["tag", "-l"], cliDir)).toBe("");
  });

  test("repo.fetch({ refPatterns: [heads, tags] }) 会像显式 heads+tags refspec 一样抓取分支与 tags", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    const secondCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "-a", "v1.0.0", "-m", "v1.0.0"], workDir);
    const tagHash = sha1(git(["rev-parse", "refs/tags/v1.0.0"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v1.0.0"], workDir);

    const repo = initRepository(localDir);
    const cliDir = join(tempDir, "cli-refpatterns-tags");

    server.clearRequests();
    await repo.fetch(server.url, { refPatterns: ["refs/heads/*", "refs/tags/*"] });
    const nanoInitialBatches = getNormalizedFetchCommandBatches(server.requests);

    git(["init", "--bare", cliDir], tempDir);
    git(["--git-dir", cliDir, "remote", "add", "origin", server.url], tempDir);
    await gitWithTimeout(
      [
        "--git-dir",
        cliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/heads/*:refs/heads/*",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );

    createFile(workDir, "third.txt", "third\n");
    git(["add", "third.txt"], workDir);
    git(["commit", "-m", "Third commit"], workDir);
    const thirdCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "-a", "v2.0.0", "-m", "v2.0.0"], workDir);
    const secondTagHash = sha1(git(["rev-parse", "refs/tags/v2.0.0"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2.0.0"], workDir);

    server.clearRequests();
    await repo.fetch(server.url, { refPatterns: ["refs/heads/*", "refs/tags/*"] });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        cliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/heads/*:refs/heads/*",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoInitialBatches).toEqual([
      [
        "command=fetch",
        "object-format=sha1",
        "thin-pack",
        "no-progress",
        "include-tag",
        "ofs-delta",
        `want ${secondCommitHash}`,
        `want ${tagHash}`,
        "done",
      ],
    ]);
    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.readBranch("main")).toBe(thirdCommitHash);
    expect(repo.refs.read("refs/tags/v2.0.0")).toBe(secondTagHash);
    expect(
      git(["--git-dir", cliDir, "tag", "-l"], tempDir).split("\n").filter(Boolean).sort(),
    ).toEqual(["v1.0.0", "v2.0.0"]);
  });

  test("repo.fetch({ refSpecs: [heads, tags] }) 会像 git fetch <refspec> 一样拒绝覆盖已有 lightweight tag", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "tag-base.txt", "tag-base\n");
    git(["add", "tag-base.txt"], workDir);
    git(["commit", "-m", "Tag base"], workDir);
    const taggedCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "v1.0.0"], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v1.0.0"], workDir);

    const repo = initRepository(localDir);
    const cliDir = join(tempDir, "cli-refspecs-tags.git");
    const refSpecs = ["refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"];

    await repo.fetch(server.url, { refSpecs });
    await gitWithTimeout(
      ["-c", "protocol.version=2", "clone", "--bare", server.url, cliDir],
      tempDir,
      15000,
    );

    createFile(workDir, "tag-moved.txt", "tag-moved\n");
    git(["add", "tag-moved.txt"], workDir);
    git(["commit", "-m", "Tag moved"], workDir);
    const movedTagCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "-f", "v1.0.0"], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "+refs/tags/v1.0.0"], workDir);

    server.clearRequests();
    const nanoPromise = repo.fetch(server.url, { refSpecs });
    const nanoSettled = nanoPromise.then(
      () => undefined,
      () => undefined,
    );
    expect(nanoPromise).rejects.toBeInstanceOf(Error);
    await nanoSettled;
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliPromise = gitWithTimeout(
      [
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/heads/*:refs/heads/*",
        "refs/tags/*:refs/tags/*",
      ],
      cliDir,
      15000,
    );
    const cliSettled = cliPromise.then(
      () => undefined,
      () => undefined,
    );
    expect(cliPromise).rejects.toBeInstanceOf(Error);
    await cliSettled;
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    expect(nanoBatches[0]).toContain("include-tag");
    expect(nanoBatches[0]).toContain(`want ${movedTagCommitHash}`);
    expect(nanoBatches[0]).toContain(`have ${mainCommitHash}`);
    expect(nanoBatches[0]).toContain(`have ${taggedCommitHash}`);
    expect(repo.readBranch("main")).toBe(movedTagCommitHash);
    expect(repo.refs.read("refs/tags/v1.0.0")).toBe(taggedCommitHash);
    expect(git(["--git-dir", cliDir, "rev-parse", "refs/heads/main"], tempDir)).toBe(
      movedTagCommitHash,
    );
    expect(git(["--git-dir", cliDir, "rev-parse", "refs/tags/v1.0.0"], tempDir)).toBe(
      taggedCommitHash,
    );
  });

  test("bare 仓库上 noTags + tag-only refPatterns 仍会像显式 tag refspec 一样抓取 tags", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    git(["tag", "-a", "v2", "-m", "v2"], workDir);
    const tagHash = sha1(git(["rev-parse", "refs/tags/v2"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2"], workDir);

    const bareCliDir = join(tempDir, "cli-no-tags-tag-only-refpatterns.git");
    const nanoDir = join(tempDir, "nano-no-tags-tag-only-refpatterns.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/tags/*"];
    const cliArgs = ["fetch", "--no-tags", "origin", "refs/tags/*:refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { noTags: true, refPatterns });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["--git-dir", bareCliDir, "-c", "protocol.version=2", ...cliArgs],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches[0]).not.toContain("include-tag");
    expect(repo.refs.read("refs/tags/v2")).toBe(tagHash);
    expect(git(["--git-dir", bareCliDir, "rev-parse", "refs/tags/v2"], tempDir)).toBe(tagHash);
  });

  test("bare 仓库上 noTags + heads+tags refPatterns 仍会像显式 refspec 一样抓取 branches 与 tags", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    const secondCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "-a", "v2", "-m", "v2"], workDir);
    const tagHash = sha1(git(["rev-parse", "refs/tags/v2"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2"], workDir);

    const bareCliDir = join(tempDir, "cli-no-tags-heads-tags-refpatterns.git");
    const nanoDir = join(tempDir, "nano-no-tags-heads-tags-refpatterns.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/heads/*", "refs/tags/*"];
    const cliArgs = [
      "fetch",
      "--no-tags",
      "origin",
      "refs/heads/*:refs/heads/*",
      "refs/tags/*:refs/tags/*",
    ];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { noTags: true, refPatterns });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["--git-dir", bareCliDir, "-c", "protocol.version=2", ...cliArgs],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches[0]).not.toContain("include-tag");
    expect(repo.readBranch("main")).toBe(secondCommitHash);
    expect(repo.refs.read("refs/tags/v2")).toBe(tagHash);
    expect(git(["--git-dir", bareCliDir, "rev-parse", "refs/heads/main"], tempDir)).toBe(
      secondCommitHash,
    );
    expect(git(["--git-dir", bareCliDir, "rev-parse", "refs/tags/v2"], tempDir)).toBe(tagHash);
  });

  test("bare 仓库上 heads+tags refSpecs 的 full follow-up 会像 git CLI 一样走两轮协商并保持首轮 have 收敛在顶层共同 tip", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    createFile(workDir, "d.txt", "D\n");
    git(["add", "d.txt"], workDir);
    git(["commit", "-m", "D"], workDir);
    const branchAnchorHash = sha1(git(["rev-parse", "HEAD~2"], workDir));
    const middleTagTargetHash = sha1(git(["rev-parse", "HEAD~1"], workDir));
    const topTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    git(["checkout", "-b", "old", branchAnchorHash], workDir);
    git(["push", repoDir, "old"], workDir);
    git(["checkout", "main"], workDir);

    git(["tag", "t-b", branchAnchorHash], workDir);
    git(["tag", "t-c", middleTagTargetHash], workDir);
    git(["tag", "-a", "t-d", "-m", "t-d", topTagTargetHash], workDir);
    git(["push", repoDir, "refs/tags/t-b"], workDir);
    git(["push", repoDir, "refs/tags/t-c"], workDir);
    git(["push", repoDir, "refs/tags/t-d"], workDir);

    const bareCliDir = join(tempDir, "cli-heads-tags-refspec-two-round.git");
    const nanoDir = join(tempDir, "nano-heads-tags-refspec-two-round.git");
    const repo = initRepository(nanoDir);
    const refSpecs = ["refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);
    await repo.fetch(server.url, { refSpecs });
    await gitWithTimeout(
      ["--git-dir", bareCliDir, "-c", "protocol.version=2", "fetch", "origin", ...refSpecs],
      tempDir,
      15000,
    );

    git(["checkout", "main"], workDir);
    createFile(workDir, "e.txt", "E\n");
    git(["add", "e.txt"], workDir);
    git(["commit", "-m", "E"], workDir);
    const newMainTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "t-e", newMainTagTargetHash], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/t-e"], workDir);

    git(["checkout", "old"], workDir);
    createFile(workDir, "old-2.txt", "O2\n");
    git(["add", "old-2.txt"], workDir);
    git(["commit", "-m", "O2"], workDir);
    git(["tag", "-a", "t-old2", "-m", "t-old2"], workDir);
    const newOldAnnotatedTagHash = sha1(git(["rev-parse", "refs/tags/t-old2"], workDir));
    git(["push", repoDir, "old"], workDir);
    git(["push", repoDir, "refs/tags/t-old2"], workDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { refSpecs });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["--git-dir", bareCliDir, "-c", "protocol.version=2", "fetch", "origin", ...refSpecs],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(2);
    expect(nanoBatches[0]).toContain("include-tag");
    expect(nanoBatches[0]).toContain(`want ${newMainTagTargetHash}`);
    expect(nanoBatches[0]).toContain(`want ${newOldAnnotatedTagHash}`);
    expect(nanoBatches[0]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${middleTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${branchAnchorHash}`);
    expect(nanoBatches[0]).not.toContain("done");
    expect(nanoBatches[1]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[1]).toContain("done");
    expect(nanoBatches[1]).not.toContain(`have ${branchAnchorHash}`);
  });

  test("bare 仓库上 heads+tags refPatterns 的 full follow-up 会像 git CLI 一样走两轮协商并保持首轮 have 收敛在顶层共同 tip", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    createFile(workDir, "d.txt", "D\n");
    git(["add", "d.txt"], workDir);
    git(["commit", "-m", "D"], workDir);
    const branchAnchorHash = sha1(git(["rev-parse", "HEAD~2"], workDir));
    const middleTagTargetHash = sha1(git(["rev-parse", "HEAD~1"], workDir));
    const topTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    git(["checkout", "-b", "old", branchAnchorHash], workDir);
    git(["push", repoDir, "old"], workDir);
    git(["checkout", "main"], workDir);

    git(["tag", "t-b", branchAnchorHash], workDir);
    git(["tag", "t-c", middleTagTargetHash], workDir);
    git(["tag", "-a", "t-d", "-m", "t-d", topTagTargetHash], workDir);
    git(["push", repoDir, "refs/tags/t-b"], workDir);
    git(["push", repoDir, "refs/tags/t-c"], workDir);
    git(["push", repoDir, "refs/tags/t-d"], workDir);

    const bareCliDir = join(tempDir, "cli-heads-tags-refpatterns-two-round.git");
    const nanoDir = join(tempDir, "nano-heads-tags-refpatterns-two-round.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/heads/*", "refs/tags/*"];

    await gitWithTimeout(
      ["-c", "protocol.version=2", "clone", "--bare", server.url, bareCliDir],
      tempDir,
      15000,
    );
    await repo.fetch(server.url, { refPatterns });

    git(["checkout", "main"], workDir);
    createFile(workDir, "e.txt", "E\n");
    git(["add", "e.txt"], workDir);
    git(["commit", "-m", "E"], workDir);
    const newMainTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "t-e", newMainTagTargetHash], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/t-e"], workDir);

    git(["checkout", "old"], workDir);
    createFile(workDir, "old-2.txt", "O2\n");
    git(["add", "old-2.txt"], workDir);
    git(["commit", "-m", "O2"], workDir);
    git(["tag", "-a", "t-old2", "-m", "t-old2"], workDir);
    const newOldAnnotatedTagHash = sha1(git(["rev-parse", "refs/tags/t-old2"], workDir));
    git(["push", repoDir, "old"], workDir);
    git(["push", repoDir, "refs/tags/t-old2"], workDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { refPatterns });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/heads/*:refs/heads/*",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(2);
    expect(nanoBatches[0]).toContain("include-tag");
    expect(nanoBatches[0]).toContain(`want ${newMainTagTargetHash}`);
    expect(nanoBatches[0]).toContain(`want ${newOldAnnotatedTagHash}`);
    expect(nanoBatches[0]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${middleTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${branchAnchorHash}`);
    expect(nanoBatches[0]).not.toContain("done");
    expect(nanoBatches[1]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[1]).toContain("done");
    expect(nanoBatches[1]).not.toContain(`have ${branchAnchorHash}`);
  });

  test("bare 仓库上 noTags + heads+tags refSpecs 的 full follow-up 会像 git CLI 一样走两轮协商且不发送 include-tag", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    createFile(workDir, "d.txt", "D\n");
    git(["add", "d.txt"], workDir);
    git(["commit", "-m", "D"], workDir);
    const branchAnchorHash = sha1(git(["rev-parse", "HEAD~2"], workDir));
    const middleTagTargetHash = sha1(git(["rev-parse", "HEAD~1"], workDir));
    const topTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    git(["checkout", "-b", "old", branchAnchorHash], workDir);
    git(["push", repoDir, "old"], workDir);
    git(["checkout", "main"], workDir);

    git(["tag", "t-b", branchAnchorHash], workDir);
    git(["tag", "t-c", middleTagTargetHash], workDir);
    git(["tag", "-a", "t-d", "-m", "t-d", topTagTargetHash], workDir);
    git(["push", repoDir, "refs/tags/t-b"], workDir);
    git(["push", repoDir, "refs/tags/t-c"], workDir);
    git(["push", repoDir, "refs/tags/t-d"], workDir);

    const bareCliDir = join(tempDir, "cli-no-tags-heads-tags-refspec-two-round.git");
    const nanoDir = join(tempDir, "nano-no-tags-heads-tags-refspec-two-round.git");
    const repo = initRepository(nanoDir);
    const refSpecs = ["refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);
    await repo.fetch(server.url, { noTags: true, refSpecs });
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );

    git(["checkout", "main"], workDir);
    createFile(workDir, "e.txt", "E\n");
    git(["add", "e.txt"], workDir);
    git(["commit", "-m", "E"], workDir);
    const newMainTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "t-e", newMainTagTargetHash], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/t-e"], workDir);

    git(["checkout", "old"], workDir);
    createFile(workDir, "old-2.txt", "O2\n");
    git(["add", "old-2.txt"], workDir);
    git(["commit", "-m", "O2"], workDir);
    git(["tag", "-a", "t-old2", "-m", "t-old2"], workDir);
    const newOldAnnotatedTagHash = sha1(git(["rev-parse", "refs/tags/t-old2"], workDir));
    git(["push", repoDir, "old"], workDir);
    git(["push", repoDir, "refs/tags/t-old2"], workDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { noTags: true, refSpecs });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(2);
    expect(nanoBatches[0]).not.toContain("include-tag");
    expect(nanoBatches[0]).toContain(`want ${newMainTagTargetHash}`);
    expect(nanoBatches[0]).toContain(`want ${newOldAnnotatedTagHash}`);
    expect(nanoBatches[0]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${middleTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${branchAnchorHash}`);
    expect(nanoBatches[0]).not.toContain("done");
    expect(nanoBatches[1]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[1]).toContain("done");
    expect(nanoBatches[1]).not.toContain(`have ${branchAnchorHash}`);
  });

  test("bare 仓库上 noTags + heads+tags refPatterns 的 full follow-up 会像 git CLI 一样走两轮协商且不发送 include-tag", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    createFile(workDir, "d.txt", "D\n");
    git(["add", "d.txt"], workDir);
    git(["commit", "-m", "D"], workDir);
    const branchAnchorHash = sha1(git(["rev-parse", "HEAD~2"], workDir));
    const middleTagTargetHash = sha1(git(["rev-parse", "HEAD~1"], workDir));
    const topTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    git(["checkout", "-b", "old", branchAnchorHash], workDir);
    git(["push", repoDir, "old"], workDir);
    git(["checkout", "main"], workDir);

    git(["tag", "t-b", branchAnchorHash], workDir);
    git(["tag", "t-c", middleTagTargetHash], workDir);
    git(["tag", "-a", "t-d", "-m", "t-d", topTagTargetHash], workDir);
    git(["push", repoDir, "refs/tags/t-b"], workDir);
    git(["push", repoDir, "refs/tags/t-c"], workDir);
    git(["push", repoDir, "refs/tags/t-d"], workDir);

    const bareCliDir = join(tempDir, "cli-no-tags-heads-tags-refpatterns-two-round.git");
    const nanoDir = join(tempDir, "nano-no-tags-heads-tags-refpatterns-two-round.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/heads/*", "refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);
    await repo.fetch(server.url, { noTags: true, refPatterns });
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        "refs/heads/*:refs/heads/*",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );

    git(["checkout", "main"], workDir);
    createFile(workDir, "e.txt", "E\n");
    git(["add", "e.txt"], workDir);
    git(["commit", "-m", "E"], workDir);
    const newMainTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "t-e", newMainTagTargetHash], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/t-e"], workDir);

    git(["checkout", "old"], workDir);
    createFile(workDir, "old-2.txt", "O2\n");
    git(["add", "old-2.txt"], workDir);
    git(["commit", "-m", "O2"], workDir);
    git(["tag", "-a", "t-old2", "-m", "t-old2"], workDir);
    const newOldAnnotatedTagHash = sha1(git(["rev-parse", "refs/tags/t-old2"], workDir));
    git(["push", repoDir, "old"], workDir);
    git(["push", repoDir, "refs/tags/t-old2"], workDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { noTags: true, refPatterns });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        "refs/heads/*:refs/heads/*",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(2);
    expect(nanoBatches[0]).not.toContain("include-tag");
    expect(nanoBatches[0]).toContain(`want ${newMainTagTargetHash}`);
    expect(nanoBatches[0]).toContain(`want ${newOldAnnotatedTagHash}`);
    expect(nanoBatches[0]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${middleTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${branchAnchorHash}`);
    expect(nanoBatches[0]).not.toContain("done");
    expect(nanoBatches[1]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[1]).toContain("done");
    expect(nanoBatches[1]).not.toContain(`have ${branchAnchorHash}`);
  });

  test("bare 仓库上 tag-only refSpecs 的 full follow-up 会像 git CLI 一样走两轮协商并避免把祖先 branch tip 混入 have", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    createFile(workDir, "d.txt", "D\n");
    git(["add", "d.txt"], workDir);
    git(["commit", "-m", "D"], workDir);
    const branchAnchorHash = sha1(git(["rev-parse", "HEAD~2"], workDir));
    const middleTagTargetHash = sha1(git(["rev-parse", "HEAD~1"], workDir));
    const topTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    git(["checkout", "-b", "old", branchAnchorHash], workDir);
    git(["push", repoDir, "old"], workDir);
    git(["checkout", "main"], workDir);

    git(["tag", "t-b", branchAnchorHash], workDir);
    git(["tag", "t-c", middleTagTargetHash], workDir);
    git(["tag", "-a", "t-d", "-m", "t-d", topTagTargetHash], workDir);
    git(["push", repoDir, "refs/tags/t-b"], workDir);
    git(["push", repoDir, "refs/tags/t-c"], workDir);
    git(["push", repoDir, "refs/tags/t-d"], workDir);

    const bareCliDir = join(tempDir, "cli-tag-only-refspec-two-round.git");
    const nanoDir = join(tempDir, "nano-tag-only-refspec-two-round.git");
    const repo = initRepository(nanoDir);
    const refSpecs = ["refs/tags/*:refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);
    await repo.fetch(server.url, { refSpecs });
    await gitWithTimeout(
      ["--git-dir", bareCliDir, "-c", "protocol.version=2", "fetch", "origin", ...refSpecs],
      tempDir,
      15000,
    );

    git(["checkout", "main"], workDir);
    createFile(workDir, "e.txt", "E\n");
    git(["add", "e.txt"], workDir);
    git(["commit", "-m", "E"], workDir);
    const newMainTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "t-e", newMainTagTargetHash], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/t-e"], workDir);

    git(["checkout", "old"], workDir);
    createFile(workDir, "old-2.txt", "O2\n");
    git(["add", "old-2.txt"], workDir);
    git(["commit", "-m", "O2"], workDir);
    git(["tag", "-a", "t-old2", "-m", "t-old2"], workDir);
    const newOldAnnotatedTagHash = sha1(git(["rev-parse", "refs/tags/t-old2"], workDir));
    git(["push", repoDir, "old"], workDir);
    git(["push", repoDir, "refs/tags/t-old2"], workDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { refSpecs });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["--git-dir", bareCliDir, "-c", "protocol.version=2", "fetch", "origin", ...refSpecs],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(2);
    expect(nanoBatches[0]).toContain(`want ${newMainTagTargetHash}`);
    expect(nanoBatches[0]).toContain(`want ${newOldAnnotatedTagHash}`);
    expect(nanoBatches[0]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${middleTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${branchAnchorHash}`);
    expect(nanoBatches[0]).not.toContain("done");
    expect(nanoBatches[1]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[1]).toContain("done");
    expect(nanoBatches[1]).not.toContain(`have ${branchAnchorHash}`);
  });

  test("bare 仓库上 tag-only refPatterns 的 full follow-up 会像 git CLI 一样走两轮协商并避免把祖先 branch tip 混入 have", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    createFile(workDir, "d.txt", "D\n");
    git(["add", "d.txt"], workDir);
    git(["commit", "-m", "D"], workDir);
    const branchAnchorHash = sha1(git(["rev-parse", "HEAD~2"], workDir));
    const middleTagTargetHash = sha1(git(["rev-parse", "HEAD~1"], workDir));
    const topTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    git(["checkout", "-b", "old", branchAnchorHash], workDir);
    git(["push", repoDir, "old"], workDir);
    git(["checkout", "main"], workDir);

    git(["tag", "t-b", branchAnchorHash], workDir);
    git(["tag", "t-c", middleTagTargetHash], workDir);
    git(["tag", "-a", "t-d", "-m", "t-d", topTagTargetHash], workDir);
    git(["push", repoDir, "refs/tags/t-b"], workDir);
    git(["push", repoDir, "refs/tags/t-c"], workDir);
    git(["push", repoDir, "refs/tags/t-d"], workDir);

    const bareCliDir = join(tempDir, "cli-tag-only-refpatterns-two-round.git");
    const nanoDir = join(tempDir, "nano-tag-only-refpatterns-two-round.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);
    await repo.fetch(server.url, { refPatterns });
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );

    git(["checkout", "main"], workDir);
    createFile(workDir, "e.txt", "E\n");
    git(["add", "e.txt"], workDir);
    git(["commit", "-m", "E"], workDir);
    const newMainTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "t-e", newMainTagTargetHash], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/t-e"], workDir);

    git(["checkout", "old"], workDir);
    createFile(workDir, "old-2.txt", "O2\n");
    git(["add", "old-2.txt"], workDir);
    git(["commit", "-m", "O2"], workDir);
    git(["tag", "-a", "t-old2", "-m", "t-old2"], workDir);
    const newOldAnnotatedTagHash = sha1(git(["rev-parse", "refs/tags/t-old2"], workDir));
    git(["push", repoDir, "old"], workDir);
    git(["push", repoDir, "refs/tags/t-old2"], workDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { refPatterns });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(2);
    expect(nanoBatches[0]).toContain(`want ${newMainTagTargetHash}`);
    expect(nanoBatches[0]).toContain(`want ${newOldAnnotatedTagHash}`);
    expect(nanoBatches[0]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${middleTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${branchAnchorHash}`);
    expect(nanoBatches[0]).not.toContain("done");
    expect(nanoBatches[1]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[1]).toContain("done");
    expect(nanoBatches[1]).not.toContain(`have ${branchAnchorHash}`);
  });

  test("bare 仓库上 noTags + tag-only refSpecs 的 full follow-up 会像 git CLI 一样走两轮协商且不发送 include-tag", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    createFile(workDir, "d.txt", "D\n");
    git(["add", "d.txt"], workDir);
    git(["commit", "-m", "D"], workDir);
    const branchAnchorHash = sha1(git(["rev-parse", "HEAD~2"], workDir));
    const middleTagTargetHash = sha1(git(["rev-parse", "HEAD~1"], workDir));
    const topTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    git(["checkout", "-b", "old", branchAnchorHash], workDir);
    git(["push", repoDir, "old"], workDir);
    git(["checkout", "main"], workDir);

    git(["tag", "t-b", branchAnchorHash], workDir);
    git(["tag", "t-c", middleTagTargetHash], workDir);
    git(["tag", "-a", "t-d", "-m", "t-d", topTagTargetHash], workDir);
    git(["push", repoDir, "refs/tags/t-b"], workDir);
    git(["push", repoDir, "refs/tags/t-c"], workDir);
    git(["push", repoDir, "refs/tags/t-d"], workDir);

    const bareCliDir = join(tempDir, "cli-no-tags-tag-only-refspec-two-round.git");
    const nanoDir = join(tempDir, "nano-no-tags-tag-only-refspec-two-round.git");
    const repo = initRepository(nanoDir);
    const refSpecs = ["refs/tags/*:refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);
    await repo.fetch(server.url, { noTags: true, refSpecs });
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );

    git(["checkout", "main"], workDir);
    createFile(workDir, "e.txt", "E\n");
    git(["add", "e.txt"], workDir);
    git(["commit", "-m", "E"], workDir);
    const newMainTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "t-e", newMainTagTargetHash], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/t-e"], workDir);

    git(["checkout", "old"], workDir);
    createFile(workDir, "old-2.txt", "O2\n");
    git(["add", "old-2.txt"], workDir);
    git(["commit", "-m", "O2"], workDir);
    git(["tag", "-a", "t-old2", "-m", "t-old2"], workDir);
    const newOldAnnotatedTagHash = sha1(git(["rev-parse", "refs/tags/t-old2"], workDir));
    git(["push", repoDir, "old"], workDir);
    git(["push", repoDir, "refs/tags/t-old2"], workDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { noTags: true, refSpecs });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(2);
    expect(nanoBatches[0]).not.toContain("include-tag");
    expect(nanoBatches[0]).toContain(`want ${newMainTagTargetHash}`);
    expect(nanoBatches[0]).toContain(`want ${newOldAnnotatedTagHash}`);
    expect(nanoBatches[0]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${middleTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${branchAnchorHash}`);
    expect(nanoBatches[0]).not.toContain("done");
    expect(nanoBatches[1]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[1]).toContain("done");
    expect(nanoBatches[1]).not.toContain(`have ${branchAnchorHash}`);
  });

  test("bare 仓库上 noTags + tag-only refPatterns 的 full follow-up 会像 git CLI 一样走两轮协商且不发送 include-tag", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "b.txt", "B\n");
    git(["add", "b.txt"], workDir);
    git(["commit", "-m", "B"], workDir);
    createFile(workDir, "c.txt", "C\n");
    git(["add", "c.txt"], workDir);
    git(["commit", "-m", "C"], workDir);
    createFile(workDir, "d.txt", "D\n");
    git(["add", "d.txt"], workDir);
    git(["commit", "-m", "D"], workDir);
    const branchAnchorHash = sha1(git(["rev-parse", "HEAD~2"], workDir));
    const middleTagTargetHash = sha1(git(["rev-parse", "HEAD~1"], workDir));
    const topTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    git(["checkout", "-b", "old", branchAnchorHash], workDir);
    git(["push", repoDir, "old"], workDir);
    git(["checkout", "main"], workDir);

    git(["tag", "t-b", branchAnchorHash], workDir);
    git(["tag", "t-c", middleTagTargetHash], workDir);
    git(["tag", "-a", "t-d", "-m", "t-d", topTagTargetHash], workDir);
    git(["push", repoDir, "refs/tags/t-b"], workDir);
    git(["push", repoDir, "refs/tags/t-c"], workDir);
    git(["push", repoDir, "refs/tags/t-d"], workDir);

    const bareCliDir = join(tempDir, "cli-no-tags-tag-only-refpatterns-two-round.git");
    const nanoDir = join(tempDir, "nano-no-tags-tag-only-refpatterns-two-round.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);
    await repo.fetch(server.url, { noTags: true, refPatterns });
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );

    git(["checkout", "main"], workDir);
    createFile(workDir, "e.txt", "E\n");
    git(["add", "e.txt"], workDir);
    git(["commit", "-m", "E"], workDir);
    const newMainTagTargetHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "t-e", newMainTagTargetHash], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/t-e"], workDir);

    git(["checkout", "old"], workDir);
    createFile(workDir, "old-2.txt", "O2\n");
    git(["add", "old-2.txt"], workDir);
    git(["commit", "-m", "O2"], workDir);
    git(["tag", "-a", "t-old2", "-m", "t-old2"], workDir);
    const newOldAnnotatedTagHash = sha1(git(["rev-parse", "refs/tags/t-old2"], workDir));
    git(["push", repoDir, "old"], workDir);
    git(["push", repoDir, "refs/tags/t-old2"], workDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { noTags: true, refPatterns });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(2);
    expect(nanoBatches[0]).not.toContain("include-tag");
    expect(nanoBatches[0]).toContain(`want ${newMainTagTargetHash}`);
    expect(nanoBatches[0]).toContain(`want ${newOldAnnotatedTagHash}`);
    expect(nanoBatches[0]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${middleTagTargetHash}`);
    expect(nanoBatches[0]).not.toContain(`have ${branchAnchorHash}`);
    expect(nanoBatches[0]).not.toContain("done");
    expect(nanoBatches[1]).toContain(`have ${topTagTargetHash}`);
    expect(nanoBatches[1]).toContain("done");
    expect(nanoBatches[1]).not.toContain(`have ${branchAnchorHash}`);
  });

  test("bare 仓库上 tag-only refPatterns 的 shallow follow-up 会像 git CLI 一样继续显式 want tag 并保持状态一致", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    git(["tag", "-a", "v2", "-m", "v2"], workDir);
    const tagHash = sha1(git(["rev-parse", "refs/tags/v2"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2"], workDir);

    const bareCliDir = join(tempDir, "cli-tag-only-refpatterns-shallow.git");
    const nanoDir = join(tempDir, "nano-tag-only-refpatterns-shallow.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/tags/*"];
    const cliArgs = ["fetch", "origin", "refs/tags/*:refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);
    await repo.fetch(server.url, { refPatterns });
    await gitWithTimeout(
      ["--git-dir", bareCliDir, "-c", "protocol.version=2", ...cliArgs],
      tempDir,
      15000,
    );

    server.clearRequests();
    const nanoDepthResult = await repo.fetch(server.url, { refPatterns, depth: 1 });
    const nanoDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--depth=1",
        "origin",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );
    const cliDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoDepthResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoDepthBatches).toEqual(cliDepthBatches);
    expect(repo.refs.read("refs/tags/v2")).toBe(tagHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));

    server.clearRequests();
    const nanoSinceResult = await Promise.allSettled([
      repo.fetch(server.url, { refPatterns, shallowSince: 1700000001 }),
    ]);
    const nanoSinceBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliSinceResult = await Promise.allSettled([
      gitWithTimeout(
        [
          "--git-dir",
          bareCliDir,
          "-c",
          "protocol.version=2",
          "fetch",
          "--shallow-since=@1700000001",
          "origin",
          "refs/tags/*:refs/tags/*",
        ],
        tempDir,
        15000,
      ),
    ]);
    const cliSinceBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoSinceResult[0]?.status).toBe(cliSinceResult[0]?.status);
    expect(nanoSinceBatches).toEqual(cliSinceBatches);
    expect(repo.refs.read("refs/tags/v2")).toBe(tagHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
  });

  test("bare 仓库上 tag-only refSpecs 的 shallow follow-up 会像 git CLI 一样继续显式 want tag 并保持状态一致", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    git(["tag", "-a", "v2", "-m", "v2"], workDir);
    const tagHash = sha1(git(["rev-parse", "refs/tags/v2"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2"], workDir);

    const bareCliDir = join(tempDir, "cli-tag-only-refspecs-shallow.git");
    const nanoDir = join(tempDir, "nano-tag-only-refspecs-shallow.git");
    const repo = initRepository(nanoDir);
    const refSpecs = ["refs/tags/*:refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);
    await repo.fetch(server.url, { refSpecs });
    await gitWithTimeout(
      ["--git-dir", bareCliDir, "-c", "protocol.version=2", "fetch", "origin", ...refSpecs],
      tempDir,
      15000,
    );

    server.clearRequests();
    const nanoDepthResult = await repo.fetch(server.url, { refSpecs, depth: 1 });
    const nanoDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--depth=1",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    const cliDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoDepthResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoDepthBatches).toEqual(cliDepthBatches);
    expect(repo.refs.read("refs/tags/v2")).toBe(tagHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));

    server.clearRequests();
    const nanoSinceResult = await Promise.allSettled([
      repo.fetch(server.url, { refSpecs, shallowSince: 1700000001 }),
    ]);
    const nanoSinceBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliSinceResult = await Promise.allSettled([
      gitWithTimeout(
        [
          "--git-dir",
          bareCliDir,
          "-c",
          "protocol.version=2",
          "fetch",
          "--shallow-since=@1700000001",
          "origin",
          ...refSpecs,
        ],
        tempDir,
        15000,
      ),
    ]);
    const cliSinceBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoSinceResult[0]?.status).toBe(cliSinceResult[0]?.status);
    expect(nanoSinceBatches).toEqual(cliSinceBatches);
    expect(repo.refs.read("refs/tags/v2")).toBe(tagHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
  });

  test("bare 仓库上 branch-only refSpecs 的 depth fetch 会像 git CLI 一样自动物化可达 tag", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    const secondCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "-a", "v2", "-m", "v2"], workDir);
    const tagHash = sha1(git(["rev-parse", "refs/tags/v2"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2"], workDir);

    const bareCliDir = join(tempDir, "cli-branch-only-refspec-depth.git");
    const nanoDir = join(tempDir, "nano-branch-only-refspec-depth.git");
    const repo = initRepository(nanoDir);
    const refSpecs = ["refs/heads/*:refs/heads/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { refSpecs, depth: 1 });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--depth=1",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.readBranch("main")).toBe(secondCommitHash);
    expect(repo.refs.read("refs/tags/v2")).toBe(tagHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
    expect(git(["--git-dir", bareCliDir, "rev-parse", "refs/tags/v2"], tempDir)).toBe(tagHash);
  });

  test("bare 仓库上 branch-only refPatterns 的 depth fetch 会像 git CLI 一样自动物化可达 tag", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    const secondCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "-a", "v2", "-m", "v2"], workDir);
    const tagHash = sha1(git(["rev-parse", "refs/tags/v2"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2"], workDir);

    const bareCliDir = join(tempDir, "cli-branch-only-refpatterns-depth.git");
    const nanoDir = join(tempDir, "nano-branch-only-refpatterns-depth.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/heads/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { refPatterns, depth: 1 });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--depth=1",
        "origin",
        "refs/heads/*:refs/heads/*",
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.readBranch("main")).toBe(secondCommitHash);
    expect(repo.refs.read("refs/tags/v2")).toBe(tagHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
    expect(git(["--git-dir", bareCliDir, "rev-parse", "refs/tags/v2"], tempDir)).toBe(tagHash);
  });

  test("bare 仓库上 exact branch refPattern 的 depth fetch 会像 git CLI 一样自动物化可达 tag", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    const secondCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "-a", "v2", "-m", "v2"], workDir);
    const tagHash = sha1(git(["rev-parse", "refs/tags/v2"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2"], workDir);

    const bareCliDir = join(tempDir, "cli-exact-branch-refpattern-depth.git");
    const nanoDir = join(tempDir, "nano-exact-branch-refpattern-depth.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/heads/main"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { refPatterns, depth: 1 });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--depth=1",
        "origin",
        "refs/heads/main:refs/heads/main",
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.readBranch("main")).toBe(secondCommitHash);
    expect(repo.refs.read("refs/tags/v2")).toBe(tagHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
    expect(git(["--git-dir", bareCliDir, "rev-parse", "refs/tags/v2"], tempDir)).toBe(tagHash);
  });

  test("bare 仓库上 branch-only refSpecs 的 shallow follow-up 会像 git CLI 一样保持请求序列与 tag/shallow 状态一致", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    git(["tag", "-a", "v2", "-m", "v2"], workDir);
    const tagHash = sha1(git(["rev-parse", "refs/tags/v2"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2"], workDir);

    const bareCliDir = join(tempDir, "cli-branch-only-refspec-shallow.git");
    const nanoDir = join(tempDir, "nano-branch-only-refspec-shallow.git");
    const repo = initRepository(nanoDir);
    const refSpecs = ["refs/heads/*:refs/heads/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);
    await repo.fetch(server.url, { refSpecs });
    await gitWithTimeout(
      ["--git-dir", bareCliDir, "-c", "protocol.version=2", "fetch", "origin", ...refSpecs],
      tempDir,
      15000,
    );

    server.clearRequests();
    const nanoDepthResult = await repo.fetch(server.url, { refSpecs, depth: 1 });
    const nanoDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--depth=1",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    const cliDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoDepthResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoDepthBatches).toEqual(cliDepthBatches);
    expect(repo.refs.read("refs/tags/v2")).toBe(tagHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));

    server.clearRequests();
    const nanoSinceResult = await Promise.allSettled([
      repo.fetch(server.url, { refSpecs, shallowSince: 1700000001 }),
    ]);
    const nanoSinceBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliSinceResult = await Promise.allSettled([
      gitWithTimeout(
        [
          "--git-dir",
          bareCliDir,
          "-c",
          "protocol.version=2",
          "fetch",
          "--shallow-since=@1700000001",
          "origin",
          ...refSpecs,
        ],
        tempDir,
        15000,
      ),
    ]);
    const cliSinceBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoSinceResult[0]?.status).toBe(cliSinceResult[0]?.status);
    expect(nanoSinceBatches).toEqual(cliSinceBatches);
    expect(repo.refs.read("refs/tags/v2")).toBe(tagHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
  });

  test("bare 仓库上 branch-only refPatterns 的 shallow follow-up 会像 git CLI 一样保持请求序列与 tag/shallow 状态一致", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    git(["tag", "-a", "v2", "-m", "v2"], workDir);
    const tagHash = sha1(git(["rev-parse", "refs/tags/v2"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2"], workDir);

    const bareCliDir = join(tempDir, "cli-branch-only-refpatterns-shallow.git");
    const nanoDir = join(tempDir, "nano-branch-only-refpatterns-shallow.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/heads/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);
    await repo.fetch(server.url, { refPatterns });
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/heads/*:refs/heads/*",
      ],
      tempDir,
      15000,
    );

    server.clearRequests();
    const nanoDepthResult = await repo.fetch(server.url, { refPatterns, depth: 1 });
    const nanoDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--depth=1",
        "origin",
        "refs/heads/*:refs/heads/*",
      ],
      tempDir,
      15000,
    );
    const cliDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoDepthResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoDepthBatches).toEqual(cliDepthBatches);
    expect(repo.refs.read("refs/tags/v2")).toBe(tagHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));

    server.clearRequests();
    const nanoSinceResult = await Promise.allSettled([
      repo.fetch(server.url, { refPatterns, shallowSince: 1700000001 }),
    ]);
    const nanoSinceBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliSinceResult = await Promise.allSettled([
      gitWithTimeout(
        [
          "--git-dir",
          bareCliDir,
          "-c",
          "protocol.version=2",
          "fetch",
          "--shallow-since=@1700000001",
          "origin",
          "refs/heads/*:refs/heads/*",
        ],
        tempDir,
        15000,
      ),
    ]);
    const cliSinceBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoSinceResult[0]?.status).toBe(cliSinceResult[0]?.status);
    expect(nanoSinceBatches).toEqual(cliSinceBatches);
    expect(repo.refs.read("refs/tags/v2")).toBe(tagHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
  });

  test("bare 仓库上 custom namespace refSpec 的 shallow follow-up 会像 git CLI 一样保持请求序列与 tag/shallow 状态一致", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    const secondCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "-a", "v2", "-m", "v2"], workDir);
    const tagHash = sha1(git(["rev-parse", "refs/tags/v2"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2"], workDir);

    const bareCliDir = join(tempDir, "cli-custom-namespace-refspec-shallow.git");
    const nanoDir = join(tempDir, "nano-custom-namespace-refspec-shallow.git");
    const repo = initRepository(nanoDir);
    const refSpecs = ["refs/heads/main:refs/remotes/origin/main"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);
    await repo.fetch(server.url, { refSpecs });
    await gitWithTimeout(
      ["--git-dir", bareCliDir, "-c", "protocol.version=2", "fetch", "origin", ...refSpecs],
      tempDir,
      15000,
    );

    server.clearRequests();
    const nanoDepthResult = await repo.fetch(server.url, { refSpecs, depth: 1 });
    const nanoDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--depth=1",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    const cliDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoDepthResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoDepthBatches).toEqual(cliDepthBatches);
    expect(repo.refs.read("refs/remotes/origin/main")).toBe(secondCommitHash);
    expect(repo.refs.read("refs/tags/v2")).toBe(tagHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));

    server.clearRequests();
    const nanoSinceResult = await Promise.allSettled([
      repo.fetch(server.url, { refSpecs, shallowSince: 1700000001 }),
    ]);
    const nanoSinceBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliSinceResult = await Promise.allSettled([
      gitWithTimeout(
        [
          "--git-dir",
          bareCliDir,
          "-c",
          "protocol.version=2",
          "fetch",
          "--shallow-since=@1700000001",
          "origin",
          ...refSpecs,
        ],
        tempDir,
        15000,
      ),
    ]);
    const cliSinceBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoSinceResult[0]?.status).toBe(cliSinceResult[0]?.status);
    expect(nanoSinceBatches).toEqual(cliSinceBatches);
    expect(repo.refs.read("refs/remotes/origin/main")).toBe(secondCommitHash);
    expect(repo.refs.read("refs/tags/v2")).toBe(tagHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
  });

  test("bare 仓库上 refSpecs 的 shallow follow-up 会像 git CLI 一样显式 want tag 且不跨本地 shallow 边界发送 have", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    git(["tag", "-a", "v2", "-m", "v2"], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2"], workDir);

    const bareCliDir = join(tempDir, "cli-refspec-shallow.git");
    const nanoDir = join(tempDir, "nano-refspec-shallow.git");
    const repo = initRepository(nanoDir);
    const refSpecs = ["refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"];

    git(["clone", "--bare", repoDir, bareCliDir], tempDir);
    await repo.fetch(server.url, { refSpecs });

    server.clearRequests();
    const nanoDepthResult = await repo.fetch(server.url, { refSpecs, depth: 1 });
    const nanoDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliDepthResult = await Promise.allSettled([
      gitWithTimeout(
        [
          "--git-dir",
          bareCliDir,
          "-c",
          "protocol.version=2",
          "fetch",
          "--depth=1",
          server.url,
          ...refSpecs,
        ],
        tempDir,
        15000,
      ),
    ]);
    const cliDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoDepthResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(cliDepthResult[0]?.status).toBe("fulfilled");
    expect(nanoDepthBatches).toEqual(cliDepthBatches);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));

    server.clearRequests();
    const nanoSinceResult = await Promise.allSettled([
      repo.fetch(server.url, { refSpecs, shallowSince: 1700000001 }),
    ]);
    const nanoSinceBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliSinceResult = await Promise.allSettled([
      gitWithTimeout(
        [
          "--git-dir",
          bareCliDir,
          "-c",
          "protocol.version=2",
          "fetch",
          "--shallow-since=@1700000001",
          server.url,
          ...refSpecs,
        ],
        tempDir,
        15000,
      ),
    ]);
    const cliSinceBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoSinceResult[0]?.status).toBe(cliSinceResult[0]?.status);
    expect(nanoSinceBatches).toEqual(cliSinceBatches);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
  });

  test("bare 仓库上 refPatterns 的 shallow follow-up 会像 git CLI 一样保持请求序列与 shallow 状态一致", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    git(["tag", "-a", "v2", "-m", "v2"], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2"], workDir);

    const bareCliDir = join(tempDir, "cli-refpatterns-shallow.git");
    const nanoDir = join(tempDir, "nano-refpatterns-shallow.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/heads/*", "refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);
    await repo.fetch(server.url, { refPatterns });
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/heads/*:refs/heads/*",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );

    server.clearRequests();
    const nanoDepthResult = await repo.fetch(server.url, { refPatterns, depth: 1 });
    const nanoDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliDepthResult = await Promise.allSettled([
      gitWithTimeout(
        [
          "--git-dir",
          bareCliDir,
          "-c",
          "protocol.version=2",
          "fetch",
          "--depth=1",
          "--tags",
          "origin",
        ],
        tempDir,
        15000,
      ),
    ]);
    const cliDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoDepthResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(cliDepthResult[0]?.status).toBe("fulfilled");
    expect(nanoDepthBatches).toEqual(cliDepthBatches);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));

    server.clearRequests();
    const nanoSinceResult = await Promise.allSettled([
      repo.fetch(server.url, { refPatterns, shallowSince: 1700000001 }),
    ]);
    const nanoSinceBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliSinceResult = await Promise.allSettled([
      gitWithTimeout(
        [
          "--git-dir",
          bareCliDir,
          "-c",
          "protocol.version=2",
          "fetch",
          "--shallow-since=@1700000001",
          "--tags",
          "origin",
        ],
        tempDir,
        15000,
      ),
    ]);
    const cliSinceBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoSinceResult[0]?.status).toBe(cliSinceResult[0]?.status);
    expect(nanoSinceBatches).toEqual(cliSinceBatches);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
  });

  test("bare 仓库上 heads+tags refPatterns 的 depth=1 follow-up 会像 git CLI 一样继续显式 want 旧 annotated tag", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "old-tag-base.txt", "old-tag-base\n");
    git(["add", "old-tag-base.txt"], workDir);
    git(["commit", "-m", "Old tag base"], workDir);
    const oldTaggedCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "-a", "v-old", oldTaggedCommitHash, "-m", "v-old"], workDir);
    const oldTagHash = sha1(git(["rev-parse", "refs/tags/v-old"], workDir));
    createFile(workDir, "tip-after-old-tag.txt", "tip-after-old-tag\n");
    git(["add", "tip-after-old-tag.txt"], workDir);
    git(["commit", "-m", "Tip after old tag"], workDir);
    const tipCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v-old"], workDir);

    const bareCliDir = join(tempDir, "cli-refpatterns-shallow-annotated-old-tag.git");
    const nanoDir = join(tempDir, "nano-refpatterns-shallow-annotated-old-tag.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/heads/*", "refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);
    await repo.fetch(server.url, { refPatterns });
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/heads/*:refs/heads/*",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );

    server.clearRequests();
    const nanoDepthResult = await repo.fetch(server.url, { refPatterns, depth: 1 });
    const nanoDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliDepthResult = await Promise.allSettled([
      gitWithTimeout(
        [
          "--git-dir",
          bareCliDir,
          "-c",
          "protocol.version=2",
          "fetch",
          "--depth=1",
          "--tags",
          "origin",
        ],
        tempDir,
        15000,
      ),
    ]);
    const cliDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoDepthResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(cliDepthResult[0]?.status).toBe("fulfilled");
    expect(nanoDepthBatches).toEqual(cliDepthBatches);
    expect(nanoDepthBatches).toHaveLength(1);
    const firstBatch = nanoDepthBatches[0] ?? [];
    expect(getNonHaveLines(firstBatch)).toEqual([
      "command=fetch",
      "object-format=sha1",
      "thin-pack",
      "no-progress",
      "ofs-delta",
      "deepen 1",
      `want ${tipCommitHash}`,
      `want ${oldTagHash}`,
    ]);
    expect(getHaveLines(firstBatch)).toContain(`have ${tipCommitHash}`);
    expect(getHaveLines(firstBatch)).toContain(`have ${oldTaggedCommitHash}`);
    expect(firstBatch).not.toContain("include-tag");
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
  });

  test("bare 仓库上 heads+tags refPatterns 的 depth=1 follow-up 会像 git CLI 一样继续显式 want 旧 lightweight tag", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "before-old-lightweight-tag-base.txt", "before-old-lightweight-tag-base\n");
    git(["add", "before-old-lightweight-tag-base.txt"], workDir);
    git(["commit", "-m", "Before old lightweight tag base"], workDir);
    createFile(workDir, "old-lightweight-tag-base.txt", "old-lightweight-tag-base\n");
    git(["add", "old-lightweight-tag-base.txt"], workDir);
    git(["commit", "-m", "Old lightweight tag base"], workDir);
    const oldTaggedCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "v-old-lightweight", oldTaggedCommitHash], workDir);
    createFile(workDir, "tip-after-old-lightweight-tag.txt", "tip-after-old-lightweight-tag\n");
    git(["add", "tip-after-old-lightweight-tag.txt"], workDir);
    git(["commit", "-m", "Tip after old lightweight tag"], workDir);
    const tipCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v-old-lightweight"], workDir);

    const bareCliDir = join(tempDir, "cli-refpatterns-shallow-lightweight-old-tag.git");
    const nanoDir = join(tempDir, "nano-refpatterns-shallow-lightweight-old-tag.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/heads/*", "refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);
    await repo.fetch(server.url, { refPatterns });
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/heads/*:refs/heads/*",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );

    server.clearRequests();
    const nanoDepthResult = await repo.fetch(server.url, { refPatterns, depth: 1 });
    const nanoDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliDepthResult = await Promise.allSettled([
      gitWithTimeout(
        [
          "--git-dir",
          bareCliDir,
          "-c",
          "protocol.version=2",
          "fetch",
          "--depth=1",
          "--tags",
          "origin",
        ],
        tempDir,
        15000,
      ),
    ]);
    const cliDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoDepthResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(cliDepthResult[0]?.status).toBe("fulfilled");
    expect(nanoDepthBatches).toEqual(cliDepthBatches);
    expect(nanoDepthBatches).toHaveLength(1);
    const firstBatch = nanoDepthBatches[0] ?? [];
    expect(getNonHaveLines(firstBatch)).toEqual([
      "command=fetch",
      "object-format=sha1",
      "thin-pack",
      "no-progress",
      "ofs-delta",
      "deepen 1",
      `want ${tipCommitHash}`,
      `want ${oldTaggedCommitHash}`,
    ]);
    expect(getHaveLines(firstBatch)).toContain(`have ${tipCommitHash}`);
    expect(getHaveLines(firstBatch)).toContain(`have ${oldTaggedCommitHash}`);
    expect(firstBatch).not.toContain("include-tag");
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
  });

  test("bare 仓库上 noTags + heads+tags refPatterns 的 depth=1 follow-up 会像 git CLI 一样显式 want tag 且保持 shallow 状态一致", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second-no-tags.txt", "second-no-tags\n");
    git(["add", "second-no-tags.txt"], workDir);
    git(["commit", "-m", "Second no-tags commit"], workDir);
    git(["tag", "-a", "v2-no-tags", "-m", "v2-no-tags"], workDir);
    const taggedCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    const tagHash = sha1(git(["rev-parse", "refs/tags/v2-no-tags"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2-no-tags"], workDir);

    const bareCliDir = join(tempDir, "cli-refpatterns-shallow-no-tags.git");
    const nanoDir = join(tempDir, "nano-refpatterns-shallow-no-tags.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/heads/*", "refs/tags/*"];

    await gitWithTimeout(
      ["-c", "protocol.version=2", "clone", "--bare", server.url, bareCliDir],
      tempDir,
      15000,
    );
    await repo.fetch(server.url, { noTags: true, refPatterns });

    server.clearRequests();
    const nanoDepthResult = await repo.fetch(server.url, { noTags: true, refPatterns, depth: 1 });
    const nanoDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliDepthResult = await Promise.allSettled([
      gitWithTimeout(
        [
          "--git-dir",
          bareCliDir,
          "-c",
          "protocol.version=2",
          "fetch",
          "--depth=1",
          "--no-tags",
          "origin",
          "refs/heads/*:refs/heads/*",
          "refs/tags/*:refs/tags/*",
        ],
        tempDir,
        15000,
      ),
    ]);
    const cliDepthBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoDepthResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(cliDepthResult[0]?.status).toBe("fulfilled");
    expect(nanoDepthBatches).toEqual(cliDepthBatches);
    expect(nanoDepthBatches).toHaveLength(1);
    const firstBatch = nanoDepthBatches[0] ?? [];
    expect(getNonHaveLines(firstBatch)).toEqual([
      "command=fetch",
      "object-format=sha1",
      "thin-pack",
      "no-progress",
      "ofs-delta",
      "deepen 1",
      `want ${taggedCommitHash}`,
      `want ${tagHash}`,
    ]);
    expect(firstBatch).not.toContain("include-tag");
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
  });

  test("本地 shallow 仓库后续 repo.fetch() 会像 git fetch 一样自动物化新增可达 tag", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "initial-tagged.txt", "initial-tagged\n");
    git(["add", "initial-tagged.txt"], workDir);
    git(["commit", "-m", "Initial tagged commit"], workDir);
    git(["tag", "-a", "v1.0.0", "-m", "v1.0.0"], workDir);
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v1.0.0"], workDir);

    const repo = initRepository(localDir);
    const cliDir = join(tempDir, "cli-shallow-followup-default-tags");

    await repo.fetch(server.url, { depth: 1 });
    await gitWithTimeout(
      ["-c", "protocol.version=2", "clone", "--depth=1", server.url, cliDir],
      tempDir,
      15000,
    );

    createFile(workDir, "followup-tagged.txt", "followup-tagged\n");
    git(["add", "followup-tagged.txt"], workDir);
    git(["commit", "-m", "Followup tagged commit"], workDir);
    const followupTaggedCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["tag", "-a", "v2.0.0", "-m", "v2.0.0"], workDir);
    const followupTagHash = sha1(git(["rev-parse", "refs/tags/v2.0.0"], workDir));
    git(["push", repoDir, "main"], workDir);
    git(["push", repoDir, "refs/tags/v2.0.0"], workDir);

    server.clearRequests();
    await repo.fetch(server.url);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(["-c", "protocol.version=2", "fetch", "origin"], cliDir, 15000);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.readBranch("main")).toBe(followupTaggedCommitHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readShallowFile(cliDir)));
    expect(repo.refs.read("refs/tags/v1.0.0")).not.toBeNull();
    expect(repo.refs.read("refs/tags/v2.0.0")).toBe(followupTagHash);
    expect(repo.refs.list("refs/tags/")).toEqual(["refs/tags/v1.0.0", "refs/tags/v2.0.0"]);
    expect(git(["tag", "-l"], cliDir).split("\n").filter(Boolean).sort()).toEqual([
      "v1.0.0",
      "v2.0.0",
    ]);
  });

  test("source shallow + lightweight boundary tag 下 repo.fetch({ shallowExclude }) 请求序列与 git CLI 一致", async () => {
    await server.stop();
    const history = await createTaggedShallowSourceRepository(tempDir, {
      repoName: "tagged-shallow-source.git",
      upstreamName: "tagged-upstream.git",
      workName: "tagged-upstream-work",
      tagName: "tag-c3-light",
    });
    server = startGitHttpBackendServer(tempDir, "/tagged-shallow-source.git");

    const cliDir = join(tempDir, "cli-shallow-exclude-light");
    const repo = initRepository(join(tempDir, "nano-shallow-exclude-light"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    server.clearRequests();
    await repo.fetch(server.url, { shallowExclude: ["tag-c3-light"] });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--shallow-exclude=tag-c3-light", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readShallowFile(cliDir)));
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.sourceBoundaryCommit, history.tipCommit]),
    );
  });

  test("source shallow + annotated boundary tag 下 repo.fetch({ shallowExclude }) 请求序列与 git CLI 一致", async () => {
    await server.stop();
    const history = await createTaggedShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "annotated-tagged-shallow-source.git",
      upstreamName: "annotated-tagged-upstream.git",
      workName: "annotated-tagged-upstream-work",
      tagName: "tag-boundary",
    });
    server = startGitHttpBackendServer(tempDir, "/annotated-tagged-shallow-source.git");

    const cliDir = join(tempDir, "cli-shallow-exclude-annotated");
    const repo = initRepository(join(tempDir, "nano-shallow-exclude-annotated"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    server.clearRequests();
    await repo.fetch(server.url, { shallowExclude: ["tag-boundary"] });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--shallow-exclude=tag-boundary", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readShallowFile(cliDir)));
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.sourceBoundaryCommit, history.tipCommit]),
    );
  });

  test("source shallow + annotated boundary tag 下 repo.fetch({ depth: 1 }) 初始状态与 git clone --depth=1 一致", async () => {
    await server.stop();
    await createTaggedShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "annotated-tagged-shallow-source-depth1.git",
      upstreamName: "annotated-tagged-upstream-depth1.git",
      workName: "annotated-tagged-upstream-work-depth1",
      tagName: "tag-boundary",
    });
    server = startGitHttpBackendServer(tempDir, "/annotated-tagged-shallow-source-depth1.git");

    const cliDir = join(tempDir, "cli-depth1-exclude-annotated");
    const repo = initRepository(join(tempDir, "nano-depth1-exclude-annotated"));

    await gitWithTimeout(
      ["-c", "protocol.version=2", "clone", "--depth=1", server.url, cliDir],
      tempDir,
      15000,
    );
    await repo.fetch(server.url, { depth: 1 });

    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readShallowFile(cliDir)));
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(git(["tag", "-l"], cliDir)).toBe("");
  });

  test("source shallow 下 repo.fetch({ shallowSince }) 会像 git CLI 一样拒绝并发送相同请求序列", async () => {
    await server.stop();
    await createShallowSourceRepository(tempDir, {
      repoName: "plain-shallow-source.git",
      upstreamName: "plain-upstream.git",
      workName: "plain-upstream-work",
    });
    server = startGitHttpBackendServer(tempDir, "/plain-shallow-source.git");

    const cliDir = join(tempDir, "cli-shallow-since");
    const repo = initRepository(join(tempDir, "nano-shallow-since"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { shallowSince: 0 });
    const nanoResult = await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--shallow-since=1970-01-01T00:00:00Z", "origin"],
      cliDir,
      15000,
    );
    const cliResult = await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult[0]?.status).toBe("rejected");
    expect(cliResult[0]?.status).toBe("rejected");
    expect(nanoBatches).toEqual(cliBatches);
  });

  test("完整仓库上 repo.fetch({ shallowExclude: [main] }) 会像 git CLI 一样继续发送祖先 have 后再拒绝", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    createFile(workDir, "third.txt", "third\n");
    git(["add", "third.txt"], workDir);
    git(["commit", "-m", "Third commit"], workDir);
    const thirdCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    const cliDir = join(tempDir, "cli-shallow-exclude-main");
    const repo = initRepository(join(tempDir, "nano-shallow-exclude-main"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { shallowExclude: ["main"] });
    const nanoResult = await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--shallow-exclude=main", "origin"],
      cliDir,
      15000,
    );
    const cliResult = await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult[0]?.status).toBe("rejected");
    expect(cliResult[0]?.status).toBe("rejected");
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    expect(nanoBatches[0]).toContain("deepen-not main");
    expect(nanoBatches[0]).toContain(`want ${thirdCommitHash}`);
    expect(nanoBatches[0]?.filter((line) => line.startsWith("have ")).length).toBeGreaterThan(1);
  });

  test("完整仓库上 repo.fetch({ shallowExclude: [<oid>] }) 会像 git CLI 一样拒绝并发送相同请求序列", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    const secondCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    const cliDir = join(tempDir, "cli-shallow-exclude-oid");
    const repo = initRepository(join(tempDir, "nano-shallow-exclude-oid"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { shallowExclude: [secondCommitHash] });
    const nanoResult = await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", `--shallow-exclude=${secondCommitHash}`, "origin"],
      cliDir,
      15000,
    );
    const cliResult = await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult[0]?.status).toBe("rejected");
    expect(cliResult[0]?.status).toBe("rejected");
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    expect(nanoBatches[0]).toContain(`deepen-not ${secondCommitHash}`);
  });

  test("完整仓库上 repo.fetch({ shallowSince }) 会像 git CLI 一样继续发送祖先 have 后再拒绝", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    createFile(workDir, "third.txt", "third\n");
    git(["add", "third.txt"], workDir);
    git(["commit", "-m", "Third commit"], workDir);
    const thirdCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    const cliDir = join(tempDir, "cli-shallow-since-complete");
    const repo = initRepository(join(tempDir, "nano-shallow-since-complete"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { shallowSince: 1700000001 });
    const nanoResult = await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--shallow-since=@1700000001", "origin"],
      cliDir,
      15000,
    );
    const cliResult = await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult[0]?.status).toBe("rejected");
    expect(cliResult[0]?.status).toBe("rejected");
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    expect(nanoBatches[0]).toContain("deepen-since 1700000001");
    expect(nanoBatches[0]).toContain(`want ${thirdCommitHash}`);
    expect(nanoBatches[0]?.filter((line) => line.startsWith("have ")).length).toBeGreaterThan(1);
  });

  test("完整仓库上多组极端 future shallowSince 会像 git CLI 一样复刻 approxidate 退化发包", async () => {
    git(["checkout", "main"], workDir);
    createFile(workDir, "second.txt", "second\n");
    git(["add", "second.txt"], workDir);
    git(["commit", "-m", "Second commit"], workDir);
    createFile(workDir, "third.txt", "third\n");
    git(["add", "third.txt"], workDir);
    git(["commit", "-m", "Third commit"], workDir);
    const thirdCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "main"], workDir);

    const cliDir = join(tempDir, "cli-shallow-since-future");
    const repo = initRepository(join(tempDir, "nano-shallow-since-future"));
    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    for (const shallowSince of [
      4_102_444_800, 4_102_444_801, 4_102_448_400, 4_102_531_200, 4_294_967_295, 4_294_967_296,
    ]) {
      server.clearRequests();
      const beforeNanoMaxAge = git(["rev-parse", `--since=@${shallowSince}`], workDir).replace(
        "--max-age=",
        "",
      );
      const nanoFetch = repo.fetch(server.url, { shallowSince });
      const nanoResult = await Promise.allSettled([nanoFetch]);
      const nanoBatches = getNormalizedFetchCommandBatches(server.requests);
      const afterNanoMaxAge = git(["rev-parse", `--since=@${shallowSince}`], workDir).replace(
        "--max-age=",
        "",
      );

      server.clearRequests();
      const beforeCliMaxAge = git(["rev-parse", `--since=@${shallowSince}`], workDir).replace(
        "--max-age=",
        "",
      );
      const cliFetch = gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", `--shallow-since=@${shallowSince}`, "origin"],
        cliDir,
        15000,
      );
      const cliResult = await Promise.allSettled([cliFetch]);
      const cliBatches = getNormalizedFetchCommandBatches(server.requests);
      const afterCliMaxAge = git(["rev-parse", `--since=@${shallowSince}`], workDir).replace(
        "--max-age=",
        "",
      );

      expect(nanoResult[0]?.status).toBe(cliResult[0]?.status);
      expect(nanoBatches).toHaveLength(1);
      expect(cliBatches).toHaveLength(1);
      expect(nanoBatches[0]?.filter((line) => !line.startsWith("deepen-since "))).toEqual(
        cliBatches[0]?.filter((line) => !line.startsWith("deepen-since ")),
      );
      expect([`deepen-since ${beforeNanoMaxAge}`, `deepen-since ${afterNanoMaxAge}`]).toContain(
        nanoBatches[0]?.find((line) => line.startsWith("deepen-since ")) ?? "",
      );
      expect([`deepen-since ${beforeCliMaxAge}`, `deepen-since ${afterCliMaxAge}`]).toContain(
        cliBatches[0]?.find((line) => line.startsWith("deepen-since ")) ?? "",
      );
      expect(nanoBatches[0]).toContain(`want ${thirdCommitHash}`);
      expect(nanoBatches[0]?.filter((line) => line.startsWith("have ")).length).toBeGreaterThan(1);
      expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readShallowFile(cliDir)));
    }
  });

  test("完整仓库上 repo.fetch({ unshallow: true }) 会像 git CLI 一样直接拒绝且不发请求", async () => {
    const cliDir = join(tempDir, "cli-complete-unshallow");
    const repo = initRepository(join(tempDir, "nano-complete-unshallow"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    server.clearRequests();
    const nanoResult = await Promise.allSettled([repo.fetch(server.url, { unshallow: true })]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliResult = await Promise.allSettled([
      gitWithTimeout(["-c", "protocol.version=2", "fetch", "--unshallow", "origin"], cliDir, 15000),
    ]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult[0]?.status).toBe("rejected");
    expect(cliResult[0]?.status).toBe("rejected");
    expect(nanoBatches).toEqual([]);
    expect(cliBatches).toEqual([]);
  });

  test("source shallow 下 repo.fetch({ unshallow: true }) 会像 git CLI 一样保持源浅边界并发送相同请求序列", async () => {
    await server.stop();
    await createShallowSourceRepository(tempDir, {
      repoName: "plain-shallow-source-unshallow.git",
      upstreamName: "plain-upstream-unshallow.git",
      workName: "plain-upstream-work-unshallow",
    });
    server = startGitHttpBackendServer(tempDir, "/plain-shallow-source-unshallow.git");

    const cliDir = join(tempDir, "cli-source-unshallow");
    const repo = initRepository(join(tempDir, "nano-source-unshallow"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { unshallow: true });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--unshallow", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBe(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readShallowFile(cliDir)));
  });

  test("merge-history source shallow 下 repo.fetch({ shallowSince }) 会像 git CLI 一样拒绝且保持双 shallow 边界", async () => {
    await server.stop();
    const history = await createMergeShallowSourceRepository(tempDir, {
      repoName: "merge-shallow-source-shallow-since.git",
      upstreamName: "merge-upstream-shallow-since.git",
      workName: "merge-upstream-work-shallow-since",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-shallow-source-shallow-since.git");

    const cliDir = join(tempDir, "cli-merge-source-shallow-since");
    const repo = initRepository(join(tempDir, "nano-merge-source-shallow-since"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { shallowSince: 0 });
    const nanoResult = await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--shallow-since=1970-01-01T00:00:00Z", "origin"],
      cliDir,
      15000,
    );
    const cliResult = await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult[0]?.status).toBe("rejected");
    expect(cliResult[0]?.status).toBe("rejected");
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    const firstBatch = nanoBatches[0] ?? [];
    expect(getNonHaveLines(firstBatch)).toEqual([
      "command=fetch",
      "object-format=sha1",
      "thin-pack",
      "no-progress",
      "include-tag",
      "ofs-delta",
      `shallow ${history.topicBoundaryCommit}`,
      `shallow ${history.mainBoundaryCommit}`,
      "deepen-since 0",
      `want ${history.tipCommit}`,
    ]);
    expect(sortHashes(getHaveLines(firstBatch))).toEqual(
      sortHashes([
        `have ${history.tipCommit}`,
        `have ${history.mergeCommit}`,
        `have ${history.mainBoundaryCommit}`,
        `have ${history.topicBoundaryCommit}`,
      ]),
    );
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );
  });

  test("merge-history source shallow 下多组极端 future shallowSince 会像 git CLI 一样复刻 approxidate 退化发包", async () => {
    await server.stop();
    const history = await createMergeShallowSourceRepository(tempDir, {
      repoName: "merge-shallow-source-future-shallow-since.git",
      upstreamName: "merge-upstream-future-shallow-since.git",
      workName: "merge-upstream-work-future-shallow-since",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-shallow-source-future-shallow-since.git");

    const cliDir = join(tempDir, "cli-merge-source-future-shallow-since");
    const repo = initRepository(join(tempDir, "nano-merge-source-future-shallow-since"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );

    for (const shallowSince of [
      4_102_444_800, 4_102_444_801, 4_102_448_400, 4_102_531_200, 4_294_967_295, 4_294_967_296,
    ]) {
      server.clearRequests();
      const beforeNanoMaxAge = git(["rev-parse", `--since=@${shallowSince}`], cliDir).replace(
        "--max-age=",
        "",
      );
      const nanoFetch = repo.fetch(server.url, { shallowSince });
      const nanoResult = await Promise.allSettled([nanoFetch]);
      const nanoBatches = getNormalizedFetchCommandBatches(server.requests);
      const afterNanoMaxAge = git(["rev-parse", `--since=@${shallowSince}`], cliDir).replace(
        "--max-age=",
        "",
      );

      server.clearRequests();
      const beforeCliMaxAge = git(["rev-parse", `--since=@${shallowSince}`], cliDir).replace(
        "--max-age=",
        "",
      );
      const cliFetch = gitWithTimeout(
        ["-c", "protocol.version=2", "fetch", `--shallow-since=@${shallowSince}`, "origin"],
        cliDir,
        15000,
      );
      const cliResult = await Promise.allSettled([cliFetch]);
      const cliBatches = getNormalizedFetchCommandBatches(server.requests);
      const afterCliMaxAge = git(["rev-parse", `--since=@${shallowSince}`], cliDir).replace(
        "--max-age=",
        "",
      );

      expect(nanoResult[0]?.status).toBe(cliResult[0]?.status);
      expect(nanoBatches).toHaveLength(1);
      expect(cliBatches).toHaveLength(1);
      const nanoBatch = nanoBatches[0] ?? [];
      const cliBatch = cliBatches[0] ?? [];
      expect(nanoBatch.filter((line) => !line.startsWith("deepen-since "))).toEqual(
        cliBatch.filter((line) => !line.startsWith("deepen-since ")),
      );
      expect([`deepen-since ${beforeNanoMaxAge}`, `deepen-since ${afterNanoMaxAge}`]).toContain(
        nanoBatch.find((line) => line.startsWith("deepen-since ")) ?? "",
      );
      expect([`deepen-since ${beforeCliMaxAge}`, `deepen-since ${afterCliMaxAge}`]).toContain(
        cliBatch.find((line) => line.startsWith("deepen-since ")) ?? "",
      );
      expect(getNonHaveLines(nanoBatch)).toContain(`shallow ${history.topicBoundaryCommit}`);
      expect(getNonHaveLines(nanoBatch)).toContain(`shallow ${history.mainBoundaryCommit}`);
      expect(getNonHaveLines(nanoBatch)).toContain(`want ${history.tipCommit}`);
      expect(sortHashes(getHaveLines(nanoBatch))).toEqual(
        sortHashes([
          `have ${history.tipCommit}`,
          `have ${history.mergeCommit}`,
          `have ${history.mainBoundaryCommit}`,
          `have ${history.topicBoundaryCommit}`,
        ]),
      );
      expect(sortUniqueHashes(repo.shallow.read())).toEqual(
        sortUniqueHashes(readShallowFile(cliDir)),
      );
      expect(sortHashes(repo.shallow.read())).toEqual(
        sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
      );
    }
  });

  test("merge-history source shallow 下完整 clone 后 repo.fetch({ deepen: 1 }) 会像 git CLI 一样保持双浅边界并发送相同 have", async () => {
    await server.stop();
    const history = await createMergeShallowSourceRepository(tempDir, {
      repoName: "merge-shallow-source-deepen.git",
      upstreamName: "merge-upstream-deepen.git",
      workName: "merge-upstream-work-deepen",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-shallow-source-deepen.git");

    const cliDir = join(tempDir, "cli-merge-source-deepen");
    const repo = initRepository(join(tempDir, "nano-merge-source-deepen"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { deepen: 1 });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--deepen=1", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBe(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    const firstBatch = nanoBatches[0] ?? [];
    expect(getNonHaveLines(firstBatch)).toEqual([
      "command=fetch",
      "object-format=sha1",
      "thin-pack",
      "no-progress",
      "include-tag",
      "ofs-delta",
      `shallow ${history.topicBoundaryCommit}`,
      `shallow ${history.mainBoundaryCommit}`,
      "deepen 1",
      "deepen-relative",
      `want ${history.tipCommit}`,
    ]);
    expect(sortHashes(getHaveLines(firstBatch))).toEqual(
      sortHashes([
        `have ${history.tipCommit}`,
        `have ${history.mergeCommit}`,
        `have ${history.mainBoundaryCommit}`,
        `have ${history.topicBoundaryCommit}`,
      ]),
    );
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );
  });

  test("merge-history source shallow 下完整 clone 后 repo.fetch({ depth: 1 }) 会像 git CLI 一样调整为三条 shallow 边界", async () => {
    await server.stop();
    const history = await createMergeShallowSourceRepository(tempDir, {
      repoName: "merge-shallow-source-depth1.git",
      upstreamName: "merge-upstream-depth1.git",
      workName: "merge-upstream-work-depth1",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-shallow-source-depth1.git");

    const cliDir = join(tempDir, "cli-merge-source-depth1");
    const repo = initRepository(join(tempDir, "nano-merge-source-depth1"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { depth: 1 });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--depth=1", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBe(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    const firstBatch = nanoBatches[0] ?? [];
    expect(getNonHaveLines(firstBatch)).toEqual([
      "command=fetch",
      "object-format=sha1",
      "thin-pack",
      "no-progress",
      "include-tag",
      "ofs-delta",
      `shallow ${history.topicBoundaryCommit}`,
      `shallow ${history.mainBoundaryCommit}`,
      "deepen 1",
      `want ${history.tipCommit}`,
    ]);
    expect(sortHashes(getHaveLines(firstBatch))).toEqual(
      sortHashes([
        `have ${history.tipCommit}`,
        `have ${history.mergeCommit}`,
        `have ${history.mainBoundaryCommit}`,
        `have ${history.topicBoundaryCommit}`,
      ]),
    );
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(repo.shallow.read()).toHaveLength(3);
    expect(sortHashes(repo.shallow.read())).not.toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );
  });

  test("merge-history source shallow + lightweight boundary tag 下完整 clone 后 repo.fetch({ deepen: 1 }) 会像 git CLI 一样保持 tag 与双 shallow 边界", async () => {
    await server.stop();
    const history = await createTaggedMergeShallowSourceRepository(tempDir, {
      repoName: "merge-lightweight-shallow-source-full-deepen.git",
      upstreamName: "merge-lightweight-upstream-full-deepen.git",
      workName: "merge-lightweight-upstream-work-full-deepen",
      tagName: "tag-boundary-light",
      tagTarget: "topic-boundary",
    });
    server = startGitHttpBackendServer(
      tempDir,
      "/merge-lightweight-shallow-source-full-deepen.git",
    );

    const cliDir = join(tempDir, "cli-merge-lightweight-source-full-deepen");
    const repo = initRepository(join(tempDir, "nano-merge-lightweight-source-full-deepen"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    expect(repo.refs.read("refs/tags/tag-boundary-light")).toBe(history.tagHash);
    expect(git(["rev-parse", "refs/tags/tag-boundary-light"], cliDir)).toBe(history.tagHash);
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { deepen: 1 });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--deepen=1", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBe(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    const firstBatch = nanoBatches[0] ?? [];
    expect(getNonHaveLines(firstBatch)).toEqual([
      "command=fetch",
      "object-format=sha1",
      "thin-pack",
      "no-progress",
      "include-tag",
      "ofs-delta",
      `shallow ${history.topicBoundaryCommit}`,
      `shallow ${history.mainBoundaryCommit}`,
      "deepen 1",
      "deepen-relative",
      `want ${history.tipCommit}`,
    ]);
    expect(sortHashes(getHaveLines(firstBatch))).toEqual(
      sortHashes([
        `have ${history.tipCommit}`,
        `have ${history.mergeCommit}`,
        `have ${history.mainBoundaryCommit}`,
        `have ${history.topicBoundaryCommit}`,
      ]),
    );
    expect(repo.refs.read("refs/tags/tag-boundary-light")).toBe(history.tagHash);
    expect(git(["rev-parse", "refs/tags/tag-boundary-light"], cliDir)).toBe(history.tagHash);
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );
  });

  test("merge-history source shallow + annotated boundary tag 下完整 clone 后 repo.fetch({ deepen: 1 }) 会像 git CLI 一样保持 tag 与双 shallow 边界", async () => {
    await server.stop();
    const history = await createTaggedMergeShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "merge-tagged-shallow-source-full-deepen.git",
      upstreamName: "merge-tagged-upstream-full-deepen.git",
      workName: "merge-tagged-upstream-work-full-deepen",
      tagName: "tag-boundary",
      tagTarget: "topic-boundary",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-tagged-shallow-source-full-deepen.git");

    const cliDir = join(tempDir, "cli-merge-tagged-source-full-deepen");
    const repo = initRepository(join(tempDir, "nano-merge-tagged-source-full-deepen"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    expect(repo.refs.read("refs/tags/tag-boundary")).toBe(history.tagHash);
    expect(git(["rev-parse", "refs/tags/tag-boundary"], cliDir)).toBe(history.tagHash);
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { deepen: 1 });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--deepen=1", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBe(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    const firstBatch = nanoBatches[0] ?? [];
    expect(getNonHaveLines(firstBatch)).toEqual([
      "command=fetch",
      "object-format=sha1",
      "thin-pack",
      "no-progress",
      "include-tag",
      "ofs-delta",
      `shallow ${history.topicBoundaryCommit}`,
      `shallow ${history.mainBoundaryCommit}`,
      "deepen 1",
      "deepen-relative",
      `want ${history.tipCommit}`,
    ]);
    expect(sortHashes(getHaveLines(firstBatch))).toEqual(
      sortHashes([
        `have ${history.tipCommit}`,
        `have ${history.mergeCommit}`,
        `have ${history.mainBoundaryCommit}`,
        `have ${history.topicBoundaryCommit}`,
      ]),
    );
    expect(repo.refs.read("refs/tags/tag-boundary")).toBe(history.tagHash);
    expect(git(["rev-parse", "refs/tags/tag-boundary"], cliDir)).toBe(history.tagHash);
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );
  });

  test("merge-history source shallow 下完整 clone 后 repo.fetch({ unshallow: true }) 会像 git CLI 一样发送 deepen 2147483647 且保持双浅边界", async () => {
    await server.stop();
    const history = await createMergeShallowSourceRepository(tempDir, {
      repoName: "merge-shallow-source-unshallow.git",
      upstreamName: "merge-upstream-unshallow.git",
      workName: "merge-upstream-work-unshallow",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-shallow-source-unshallow.git");

    const cliDir = join(tempDir, "cli-merge-source-unshallow");
    const repo = initRepository(join(tempDir, "nano-merge-source-unshallow"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { unshallow: true });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--unshallow", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBe(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    const firstBatch = nanoBatches[0] ?? [];
    expect(getNonHaveLines(firstBatch)).toEqual([
      "command=fetch",
      "object-format=sha1",
      "thin-pack",
      "no-progress",
      "include-tag",
      "ofs-delta",
      `shallow ${history.topicBoundaryCommit}`,
      `shallow ${history.mainBoundaryCommit}`,
      "deepen 2147483647",
      `want ${history.tipCommit}`,
    ]);
    expect(sortHashes(getHaveLines(firstBatch))).toEqual(
      sortHashes([
        `have ${history.tipCommit}`,
        `have ${history.mergeCommit}`,
        `have ${history.mainBoundaryCommit}`,
        `have ${history.topicBoundaryCommit}`,
      ]),
    );
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );
  });

  test("merge-history source shallow + lightweight boundary tag 下 repo.fetch({ shallowExclude }) 会像 git CLI 一样拒绝且保持 tag/shallow 状态不变", async () => {
    await server.stop();
    const history = await createTaggedMergeShallowSourceRepository(tempDir, {
      repoName: "merge-lightweight-shallow-source-exclude.git",
      upstreamName: "merge-lightweight-upstream-exclude.git",
      workName: "merge-lightweight-upstream-work-exclude",
      tagName: "tag-boundary-light",
      tagTarget: "topic-boundary",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-lightweight-shallow-source-exclude.git");

    const cliDir = join(tempDir, "cli-merge-lightweight-source-shallow-exclude");
    const repo = initRepository(join(tempDir, "nano-merge-lightweight-source-shallow-exclude"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );
    expect(repo.refs.read("refs/tags/tag-boundary-light")).toBe(history.tagHash);
    expect(git(["rev-parse", "refs/tags/tag-boundary-light"], cliDir)).toBe(history.tagHash);

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { shallowExclude: ["tag-boundary-light"] });
    expect(nanoFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--shallow-exclude=tag-boundary-light", "origin"],
      cliDir,
      15000,
    );
    expect(cliFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    const firstBatch = nanoBatches[0] ?? [];
    expect(getNonHaveLines(firstBatch)).toEqual([
      "command=fetch",
      "object-format=sha1",
      "thin-pack",
      "no-progress",
      "include-tag",
      "ofs-delta",
      `shallow ${history.topicBoundaryCommit}`,
      `shallow ${history.mainBoundaryCommit}`,
      "deepen-not tag-boundary-light",
      `want ${history.tipCommit}`,
    ]);
    expect(sortHashes(getHaveLines(firstBatch))).toEqual(
      sortHashes([
        `have ${history.tipCommit}`,
        `have ${history.topicBoundaryCommit}`,
        `have ${history.mergeCommit}`,
        `have ${history.mainBoundaryCommit}`,
      ]),
    );
    expect(repo.refs.read("refs/tags/tag-boundary-light")).toBe(history.tagHash);
    expect(git(["rev-parse", "refs/tags/tag-boundary-light"], cliDir)).toBe(history.tagHash);
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );
  });

  test("merge-history source shallow + annotated boundary tag 下 repo.fetch({ shallowExclude }) 会像 git CLI 一样拒绝且保持 tag/shallow 状态不变", async () => {
    await server.stop();
    const history = await createTaggedMergeShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "merge-tagged-shallow-source-exclude.git",
      upstreamName: "merge-tagged-upstream-exclude.git",
      workName: "merge-tagged-upstream-work-exclude",
      tagName: "tag-boundary",
      tagTarget: "topic-boundary",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-tagged-shallow-source-exclude.git");

    const cliDir = join(tempDir, "cli-merge-source-shallow-exclude");
    const repo = initRepository(join(tempDir, "nano-merge-source-shallow-exclude"));

    await gitWithTimeout(["-c", "protocol.version=2", "clone", server.url, cliDir], tempDir, 15000);
    await repo.fetch(server.url);

    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );
    expect(repo.refs.read("refs/tags/tag-boundary")).toBe(history.tagHash);

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { shallowExclude: ["tag-boundary"] });
    expect(nanoFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--shallow-exclude=tag-boundary", "origin"],
      cliDir,
      15000,
    );
    expect(cliFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    const firstBatch = nanoBatches[0] ?? [];
    expect(getNonHaveLines(firstBatch)).toEqual([
      "command=fetch",
      "object-format=sha1",
      "thin-pack",
      "no-progress",
      "include-tag",
      "ofs-delta",
      `shallow ${history.topicBoundaryCommit}`,
      `shallow ${history.mainBoundaryCommit}`,
      "deepen-not tag-boundary",
      `want ${history.tipCommit}`,
    ]);
    expect(sortHashes(getHaveLines(firstBatch))).toEqual(
      sortHashes([
        `have ${history.tipCommit}`,
        `have ${history.topicBoundaryCommit}`,
        `have ${history.mergeCommit}`,
        `have ${history.mainBoundaryCommit}`,
      ]),
    );
    expect(repo.refs.read("refs/tags/tag-boundary")).toBe(history.tagHash);
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(
      sortHashes([history.topicBoundaryCommit, history.mainBoundaryCommit]),
    );
  });

  test("merge-history source shallow + annotated boundary tag 下 depth=1 初始 fetch 后 shallowExclude 会像 git CLI 一样推进单一 shallow 边界且不物化 tag", async () => {
    await server.stop();
    const history = await createTaggedMergeShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "merge-tagged-shallow-source-depth1-exclude.git",
      upstreamName: "merge-tagged-upstream-depth1-exclude.git",
      workName: "merge-tagged-upstream-work-depth1-exclude",
      tagName: "tag-boundary",
      tagTarget: "topic-boundary",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-tagged-shallow-source-depth1-exclude.git");

    const cliDir = join(tempDir, "cli-merge-source-depth1-shallow-exclude");
    const repo = initRepository(join(tempDir, "nano-merge-source-depth1-shallow-exclude"));

    await gitWithTimeout(
      ["-c", "protocol.version=2", "clone", "--depth=1", server.url, cliDir],
      tempDir,
      15000,
    );
    await repo.fetch(server.url, { depth: 1 });

    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(git(["tag", "-l"], cliDir)).toBe("");
    expect(repo.readBranch("main") === history.tipCommit).toBe(true);
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes([history.tipCommit]));

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { shallowExclude: ["tag-boundary"] });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--shallow-exclude=tag-boundary", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toEqual([
      [
        "command=fetch",
        "object-format=sha1",
        "thin-pack",
        "no-progress",
        "include-tag",
        "ofs-delta",
        `shallow ${history.tipCommit}`,
        "deepen-not tag-boundary",
        `want ${history.tipCommit}`,
        `have ${history.tipCommit}`,
      ],
    ]);
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(git(["tag", "-l"], cliDir)).toBe("");
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(repo.shallow.read()).toHaveLength(1);
    expect(repo.shallow.read()).not.toEqual([history.tipCommit]);
  });

  test("merge-history source shallow + annotated boundary tag 下 depth=1 初始 fetch 后 deepen 会像 git CLI 一样推进单一 shallow 边界且不物化 tag", async () => {
    await server.stop();
    const history = await createTaggedMergeShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "merge-tagged-shallow-source-depth1-deepen.git",
      upstreamName: "merge-tagged-upstream-depth1-deepen.git",
      workName: "merge-tagged-upstream-work-depth1-deepen",
      tagName: "tag-boundary",
      tagTarget: "topic-boundary",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-tagged-shallow-source-depth1-deepen.git");

    const cliDir = join(tempDir, "cli-merge-source-depth1-deepen");
    const repo = initRepository(join(tempDir, "nano-merge-source-depth1-deepen"));

    await gitWithTimeout(
      ["-c", "protocol.version=2", "clone", "--depth=1", server.url, cliDir],
      tempDir,
      15000,
    );
    await repo.fetch(server.url, { depth: 1 });

    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(git(["tag", "-l"], cliDir)).toBe("");
    expect(repo.readBranch("main") === history.tipCommit).toBe(true);
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes([history.tipCommit]));

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { deepen: 1 });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--deepen=1", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toEqual([
      [
        "command=fetch",
        "object-format=sha1",
        "thin-pack",
        "no-progress",
        "include-tag",
        "ofs-delta",
        `shallow ${history.tipCommit}`,
        "deepen 1",
        "deepen-relative",
        `want ${history.tipCommit}`,
        `have ${history.tipCommit}`,
      ],
    ]);
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(git(["tag", "-l"], cliDir)).toBe("");
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(repo.shallow.read()).toHaveLength(1);
    expect(repo.shallow.read()).not.toEqual([history.tipCommit]);
  });

  test("merge-history source shallow + lightweight boundary tag 下 depth=1 初始 fetch 后 shallowExclude 会像 git CLI 一样推进单一 shallow 边界且不物化 tag", async () => {
    await server.stop();
    const history = await createTaggedMergeShallowSourceRepository(tempDir, {
      repoName: "merge-lightweight-shallow-source-depth1-exclude.git",
      upstreamName: "merge-lightweight-upstream-depth1-exclude.git",
      workName: "merge-lightweight-upstream-work-depth1-exclude",
      tagName: "tag-boundary-light",
      tagTarget: "topic-boundary",
    });
    server = startGitHttpBackendServer(
      tempDir,
      "/merge-lightweight-shallow-source-depth1-exclude.git",
    );

    const cliDir = join(tempDir, "cli-merge-lightweight-source-depth1-shallow-exclude");
    const repo = initRepository(
      join(tempDir, "nano-merge-lightweight-source-depth1-shallow-exclude"),
    );

    await gitWithTimeout(
      ["-c", "protocol.version=2", "clone", "--depth=1", server.url, cliDir],
      tempDir,
      15000,
    );
    await repo.fetch(server.url, { depth: 1 });

    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(git(["tag", "-l"], cliDir)).toBe("");
    expect(repo.readBranch("main") === history.tipCommit).toBe(true);
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes([history.tipCommit]));

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { shallowExclude: ["tag-boundary-light"] });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--shallow-exclude=tag-boundary-light", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toEqual([
      [
        "command=fetch",
        "object-format=sha1",
        "thin-pack",
        "no-progress",
        "include-tag",
        "ofs-delta",
        `shallow ${history.tipCommit}`,
        "deepen-not tag-boundary-light",
        `want ${history.tipCommit}`,
        `have ${history.tipCommit}`,
      ],
    ]);
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(git(["tag", "-l"], cliDir)).toBe("");
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(repo.shallow.read()).toHaveLength(1);
    expect(repo.shallow.read()).not.toEqual([history.tipCommit]);
  });

  test("merge-history source shallow + lightweight boundary tag 下 depth=1 初始 fetch 后 deepen 会像 git CLI 一样推进单一 shallow 边界且不物化 tag", async () => {
    await server.stop();
    const history = await createTaggedMergeShallowSourceRepository(tempDir, {
      repoName: "merge-lightweight-shallow-source-depth1-deepen.git",
      upstreamName: "merge-lightweight-upstream-depth1-deepen.git",
      workName: "merge-lightweight-upstream-work-depth1-deepen",
      tagName: "tag-boundary-light",
      tagTarget: "topic-boundary",
    });
    server = startGitHttpBackendServer(
      tempDir,
      "/merge-lightweight-shallow-source-depth1-deepen.git",
    );

    const cliDir = join(tempDir, "cli-merge-lightweight-source-depth1-deepen");
    const repo = initRepository(join(tempDir, "nano-merge-lightweight-source-depth1-deepen"));

    await gitWithTimeout(
      ["-c", "protocol.version=2", "clone", "--depth=1", server.url, cliDir],
      tempDir,
      15000,
    );
    await repo.fetch(server.url, { depth: 1 });

    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(git(["tag", "-l"], cliDir)).toBe("");
    expect(repo.readBranch("main") === history.tipCommit).toBe(true);
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes([history.tipCommit]));

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { deepen: 1 });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["-c", "protocol.version=2", "fetch", "--deepen=1", "origin"],
      cliDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toEqual([
      [
        "command=fetch",
        "object-format=sha1",
        "thin-pack",
        "no-progress",
        "include-tag",
        "ofs-delta",
        `shallow ${history.tipCommit}`,
        "deepen 1",
        "deepen-relative",
        `want ${history.tipCommit}`,
        `have ${history.tipCommit}`,
      ],
    ]);
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(git(["tag", "-l"], cliDir)).toBe("");
    expect(sortUniqueHashes(repo.shallow.read())).toEqual(
      sortUniqueHashes(readShallowFile(cliDir)),
    );
    expect(repo.shallow.read()).toHaveLength(1);
    expect(repo.shallow.read()).not.toEqual([history.tipCommit]);
  });

  test("source shallow 下显式 branch-only refPatterns 的初始 full fetch 会像 bare git CLI 一样拒绝且不落地 refs", async () => {
    await server.stop();
    await createShallowSourceRepository(tempDir, {
      repoName: "plain-shallow-source-branch-only.git",
      upstreamName: "plain-upstream-branch-only.git",
      workName: "plain-upstream-work-branch-only",
    });
    server = startGitHttpBackendServer(tempDir, "/plain-shallow-source-branch-only.git");

    const bareCliDir = join(tempDir, "cli-source-branch-only.git");
    const repo = initRepository(join(tempDir, "nano-source-branch-only.git"));
    const refPatterns = ["refs/heads/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { refPatterns });
    expect(nanoFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/heads/*:refs/heads/*",
      ],
      tempDir,
      15000,
    );
    expect(cliFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.readBranch("main")).toBeNull();
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("merge-history source shallow 下显式 branch-only refPatterns 的初始 full fetch 会像 bare git CLI 一样拒绝且不落地 refs", async () => {
    await server.stop();
    await createMergeShallowSourceRepository(tempDir, {
      repoName: "merge-shallow-source-branch-only.git",
      upstreamName: "merge-upstream-branch-only.git",
      workName: "merge-upstream-work-branch-only",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-shallow-source-branch-only.git");

    const bareCliDir = join(tempDir, "cli-merge-source-branch-only.git");
    const repo = initRepository(join(tempDir, "nano-merge-source-branch-only.git"));
    const refPatterns = ["refs/heads/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { refPatterns });
    expect(nanoFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/heads/*:refs/heads/*",
      ],
      tempDir,
      15000,
    );
    expect(cliFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.readBranch("main")).toBeNull();
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("source shallow 下显式 branch-only refSpecs 的 depth=1 初始 fetch 与 deepen follow-up 会像 bare git CLI 一样成功并推进 shallow 边界", async () => {
    await server.stop();
    const history = await createShallowSourceRepository(tempDir, {
      repoName: "plain-shallow-source-branch-only-refspec-depth1.git",
      upstreamName: "plain-upstream-branch-only-refspec-depth1.git",
      workName: "plain-upstream-work-branch-only-refspec-depth1",
    });
    server = startGitHttpBackendServer(
      tempDir,
      "/plain-shallow-source-branch-only-refspec-depth1.git",
    );

    const bareCliDir = join(tempDir, "cli-source-branch-only-refspec-depth1.git");
    const repo = initRepository(join(tempDir, "nano-source-branch-only-refspec-depth1.git"));
    const refSpecs = ["refs/heads/*:refs/heads/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoInitialResult = await repo.fetch(server.url, { refSpecs, depth: 1 });
    const nanoInitialBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--depth=1",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    const cliInitialBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoInitialResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoInitialBatches).toEqual(cliInitialBatches);
    expect(nanoInitialBatches).toEqual([
      [
        "command=fetch",
        "object-format=sha1",
        "thin-pack",
        "no-progress",
        "include-tag",
        "ofs-delta",
        "deepen 1",
        `want ${history.tipCommit}`,
        "done",
      ],
    ]);
    expect(repo.readBranch("main") === history.tipCommit).toBe(true);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes([history.tipCommit]));

    server.clearRequests();
    const nanoFollowupResult = await repo.fetch(server.url, { refSpecs, deepen: 1 });
    const nanoFollowupBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--deepen=1",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    const cliFollowupBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoFollowupResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoFollowupBatches).toEqual(cliFollowupBatches);
    expect(nanoFollowupBatches).toEqual([
      [
        "command=fetch",
        "object-format=sha1",
        "thin-pack",
        "no-progress",
        "include-tag",
        "ofs-delta",
        `shallow ${history.tipCommit}`,
        "deepen 1",
        "deepen-relative",
        `want ${history.tipCommit}`,
        `have ${history.tipCommit}`,
      ],
    ]);
    expect(repo.readBranch("main") === history.tipCommit).toBe(true);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes([history.sourceBoundaryCommit]));
  });

  test("merge-history source shallow 下显式 branch-only refSpecs 的 depth=1 初始 fetch 与 deepen follow-up 会像 bare git CLI 一样成功并推进 shallow 边界", async () => {
    await server.stop();
    const history = await createMergeShallowSourceRepository(tempDir, {
      repoName: "merge-shallow-source-branch-only-refspec-depth1.git",
      upstreamName: "merge-upstream-branch-only-refspec-depth1.git",
      workName: "merge-upstream-work-branch-only-refspec-depth1",
    });
    server = startGitHttpBackendServer(
      tempDir,
      "/merge-shallow-source-branch-only-refspec-depth1.git",
    );

    const bareCliDir = join(tempDir, "cli-merge-source-branch-only-refspec-depth1.git");
    const repo = initRepository(join(tempDir, "nano-merge-source-branch-only-refspec-depth1.git"));
    const refSpecs = ["refs/heads/*:refs/heads/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoInitialResult = await repo.fetch(server.url, { refSpecs, depth: 1 });
    const nanoInitialBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--depth=1",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    const cliInitialBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoInitialResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoInitialBatches).toEqual(cliInitialBatches);
    expect(nanoInitialBatches).toEqual([
      [
        "command=fetch",
        "object-format=sha1",
        "thin-pack",
        "no-progress",
        "include-tag",
        "ofs-delta",
        "deepen 1",
        `want ${history.tipCommit}`,
        "done",
      ],
    ]);
    expect(repo.readBranch("main") === history.tipCommit).toBe(true);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes([history.tipCommit]));

    server.clearRequests();
    const nanoFollowupResult = await repo.fetch(server.url, { refSpecs, deepen: 1 });
    const nanoFollowupBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--deepen=1",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    const cliFollowupBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoFollowupResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoFollowupBatches).toEqual(cliFollowupBatches);
    expect(nanoFollowupBatches).toHaveLength(1);
    const firstBatch = nanoFollowupBatches[0] ?? [];
    expect(getNonHaveLines(firstBatch)).toEqual([
      "command=fetch",
      "object-format=sha1",
      "thin-pack",
      "no-progress",
      "include-tag",
      "ofs-delta",
      `shallow ${history.tipCommit}`,
      "deepen 1",
      "deepen-relative",
      `want ${history.tipCommit}`,
    ]);
    expect(sortHashes(getHaveLines(firstBatch))).toEqual(sortHashes([`have ${history.tipCommit}`]));
    expect(repo.readBranch("main") === history.tipCommit).toBe(true);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
    expect(repo.shallow.read()).not.toEqual([history.tipCommit]);
  });

  test("source shallow 下显式 exact branch refPattern 的初始 full fetch 会像 bare git CLI 一样拒绝且不落地 refs", async () => {
    await server.stop();
    await createShallowSourceRepository(tempDir, {
      repoName: "plain-shallow-source-exact-branch.git",
      upstreamName: "plain-upstream-exact-branch.git",
      workName: "plain-upstream-work-exact-branch",
    });
    server = startGitHttpBackendServer(tempDir, "/plain-shallow-source-exact-branch.git");

    const bareCliDir = join(tempDir, "cli-source-exact-branch.git");
    const repo = initRepository(join(tempDir, "nano-source-exact-branch.git"));
    const refPatterns = ["refs/heads/main"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { refPatterns });
    expect(nanoFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/heads/main:refs/heads/main",
      ],
      tempDir,
      15000,
    );
    expect(cliFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.readBranch("main")).toBeNull();
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("merge-history source shallow 下显式 exact branch refPattern 的初始 full fetch 会像 bare git CLI 一样拒绝且不落地 refs", async () => {
    await server.stop();
    await createMergeShallowSourceRepository(tempDir, {
      repoName: "merge-shallow-source-exact-branch.git",
      upstreamName: "merge-upstream-exact-branch.git",
      workName: "merge-upstream-work-exact-branch",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-shallow-source-exact-branch.git");

    const bareCliDir = join(tempDir, "cli-merge-source-exact-branch.git");
    const repo = initRepository(join(tempDir, "nano-merge-source-exact-branch.git"));
    const refPatterns = ["refs/heads/main"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { refPatterns });
    expect(nanoFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/heads/main:refs/heads/main",
      ],
      tempDir,
      15000,
    );
    expect(cliFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.readBranch("main")).toBeNull();
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("source shallow 下显式 custom namespace refSpec 的初始 full fetch 会像 bare git CLI 一样成功但跳过 ref 更新", async () => {
    await server.stop();
    await createShallowSourceRepository(tempDir, {
      repoName: "plain-shallow-source-custom-ns.git",
      upstreamName: "plain-upstream-custom-ns.git",
      workName: "plain-upstream-work-custom-ns",
    });
    server = startGitHttpBackendServer(tempDir, "/plain-shallow-source-custom-ns.git");

    const bareCliDir = join(tempDir, "cli-source-custom-ns.git");
    const repo = initRepository(join(tempDir, "nano-source-custom-ns.git"));
    const refSpecs = ["refs/heads/main:refs/remotes/origin/main"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { refSpecs });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["--git-dir", bareCliDir, "-c", "protocol.version=2", "fetch", "origin", ...refSpecs],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("merge-history source shallow 下显式 custom namespace refSpec 的初始 full fetch 会像 bare git CLI 一样成功但跳过 ref 更新", async () => {
    await server.stop();
    await createMergeShallowSourceRepository(tempDir, {
      repoName: "merge-shallow-source-custom-ns.git",
      upstreamName: "merge-upstream-custom-ns.git",
      workName: "merge-upstream-work-custom-ns",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-shallow-source-custom-ns.git");

    const bareCliDir = join(tempDir, "cli-merge-source-custom-ns.git");
    const repo = initRepository(join(tempDir, "nano-merge-source-custom-ns.git"));
    const refSpecs = ["refs/heads/main:refs/remotes/origin/main"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { refSpecs });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      ["--git-dir", bareCliDir, "-c", "protocol.version=2", "fetch", "origin", ...refSpecs],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("source shallow 下显式 custom namespace refSpec 的 unshallow follow-up 会像 bare git CLI 一样直接拒绝且不发请求", async () => {
    await server.stop();
    await createShallowSourceRepository(tempDir, {
      repoName: "plain-shallow-source-custom-ns-unshallow.git",
      upstreamName: "plain-upstream-custom-ns-unshallow.git",
      workName: "plain-upstream-work-custom-ns-unshallow",
    });
    server = startGitHttpBackendServer(tempDir, "/plain-shallow-source-custom-ns-unshallow.git");

    const bareCliDir = join(tempDir, "cli-source-custom-ns-unshallow.git");
    const repo = initRepository(join(tempDir, "nano-source-custom-ns-unshallow.git"));
    const refSpecs = ["refs/heads/main:refs/remotes/origin/main"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    await repo.fetch(server.url, { refSpecs });
    await gitWithTimeout(
      ["--git-dir", bareCliDir, "-c", "protocol.version=2", "fetch", "origin", ...refSpecs],
      tempDir,
      15000,
    );

    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);

    server.clearRequests();
    const nanoResult = await Promise.allSettled([
      repo.fetch(server.url, { refSpecs, unshallow: true }),
    ]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliResult = await Promise.allSettled([
      gitWithTimeout(
        [
          "--git-dir",
          bareCliDir,
          "-c",
          "protocol.version=2",
          "fetch",
          "--unshallow",
          "origin",
          ...refSpecs,
        ],
        tempDir,
        15000,
      ),
    ]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult[0]?.status).toBe("rejected");
    expect(cliResult[0]?.status).toBe("rejected");
    expect(nanoBatches).toEqual([]);
    expect(cliBatches).toEqual([]);
    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("merge-history source shallow 下显式 custom namespace refSpec 的 unshallow follow-up 会像 bare git CLI 一样直接拒绝且不发请求", async () => {
    await server.stop();
    await createMergeShallowSourceRepository(tempDir, {
      repoName: "merge-shallow-source-custom-ns-unshallow.git",
      upstreamName: "merge-upstream-custom-ns-unshallow.git",
      workName: "merge-upstream-work-custom-ns-unshallow",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-shallow-source-custom-ns-unshallow.git");

    const bareCliDir = join(tempDir, "cli-merge-source-custom-ns-unshallow.git");
    const repo = initRepository(join(tempDir, "nano-merge-source-custom-ns-unshallow.git"));
    const refSpecs = ["refs/heads/main:refs/remotes/origin/main"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    await repo.fetch(server.url, { refSpecs });
    await gitWithTimeout(
      ["--git-dir", bareCliDir, "-c", "protocol.version=2", "fetch", "origin", ...refSpecs],
      tempDir,
      15000,
    );

    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);

    server.clearRequests();
    const nanoResult = await Promise.allSettled([
      repo.fetch(server.url, { refSpecs, unshallow: true }),
    ]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliResult = await Promise.allSettled([
      gitWithTimeout(
        [
          "--git-dir",
          bareCliDir,
          "-c",
          "protocol.version=2",
          "fetch",
          "--unshallow",
          "origin",
          ...refSpecs,
        ],
        tempDir,
        15000,
      ),
    ]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult[0]?.status).toBe("rejected");
    expect(cliResult[0]?.status).toBe("rejected");
    expect(nanoBatches).toEqual([]);
    expect(cliBatches).toEqual([]);
    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("source shallow + annotated boundary tag 下显式 tag-only refPatterns 的 shallow-since follow-up 会像 bare git CLI 一样拒绝且不落地 tag", async () => {
    await server.stop();
    await createTaggedShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "annotated-tagged-source-tag-only.git",
      upstreamName: "annotated-tagged-upstream-tag-only.git",
      workName: "annotated-tagged-upstream-work-tag-only",
      tagName: "tag-boundary",
    });
    server = startGitHttpBackendServer(tempDir, "/annotated-tagged-source-tag-only.git");

    const bareCliDir = join(tempDir, "cli-source-tag-only.git");
    const nanoDir = join(tempDir, "nano-source-tag-only.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    await repo.fetch(server.url, { refPatterns });
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );

    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(
      git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)", "refs/tags"], tempDir),
    ).toBe("");

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { refPatterns, shallowSince: 0 });
    expect(nanoFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--shallow-since=1970-01-01T00:00:00Z",
        "origin",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );
    expect(cliFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(repo.shallow.read()).toEqual([]);
    expect(
      git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)", "refs/tags"], tempDir),
    ).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("merge-history source shallow + annotated boundary tag 下显式 tag-only refPatterns 的 shallow-since follow-up 会像 bare git CLI 一样拒绝且不落地 tag", async () => {
    await server.stop();
    const history = await createTaggedMergeShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "merge-tagged-source-tag-only.git",
      upstreamName: "merge-tagged-upstream-tag-only.git",
      workName: "merge-tagged-upstream-work-tag-only",
      tagName: "tag-boundary",
      tagTarget: "topic-boundary",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-tagged-source-tag-only.git");

    const bareCliDir = join(tempDir, "cli-merge-source-tag-only.git");
    const nanoDir = join(tempDir, "nano-merge-source-tag-only.git");
    const repo = initRepository(nanoDir);
    const refPatterns = ["refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    await repo.fetch(server.url, { refPatterns });
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "origin",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );

    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(repo.shallow.read()).toEqual([]);
    expect(
      git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)", "refs/tags"], tempDir),
    ).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { refPatterns, shallowSince: 0 });
    expect(nanoFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--shallow-since=1970-01-01T00:00:00Z",
        "origin",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );
    expect(cliFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    const firstBatch = nanoBatches[0] ?? [];
    expect(getNonHaveLines(firstBatch)).toContain("deepen-since 0");
    expect(getNonHaveLines(firstBatch)).toContain(`want ${history.tagHash}`);
    expect(getHaveLines(firstBatch)).toEqual([]);
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(repo.shallow.read()).toEqual([]);
    expect(
      git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)", "refs/tags"], tempDir),
    ).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("source shallow + annotated boundary tag 下显式 tag-only refSpecs 的 shallow-exclude follow-up 会像 bare git CLI 一样拒绝且保持 tag/shallow 状态不变", async () => {
    await server.stop();
    const history = await createTaggedShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "annotated-tagged-source-tag-only-refspec.git",
      upstreamName: "annotated-tagged-upstream-tag-only-refspec.git",
      workName: "annotated-tagged-upstream-work-tag-only-refspec",
      tagName: "tag-boundary",
    });
    server = startGitHttpBackendServer(tempDir, "/annotated-tagged-source-tag-only-refspec.git");

    const bareCliDir = join(tempDir, "cli-source-tag-only-refspec.git");
    const nanoDir = join(tempDir, "nano-source-tag-only-refspec.git");
    const repo = initRepository(nanoDir);
    const refSpecs = ["refs/tags/*:refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    await repo.fetch(server.url, { refSpecs, depth: 1 });
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--depth=1",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );

    const tagHash = repo.refs.read("refs/tags/tag-boundary");
    expect(tagHash).not.toBeNull();
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes([history.sourceBoundaryCommit]));

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { refSpecs, shallowExclude: ["tag-boundary"] });
    expect(nanoFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--shallow-exclude=tag-boundary",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    expect(cliFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toEqual([
      [
        "command=fetch",
        "object-format=sha1",
        "thin-pack",
        "no-progress",
        "include-tag",
        "ofs-delta",
        `shallow ${history.sourceBoundaryCommit}`,
        "deepen-not tag-boundary",
        `want ${tagHash}`,
        `have ${history.sourceBoundaryCommit}`,
      ],
    ]);
    expect(repo.refs.read("refs/tags/tag-boundary")).toBe(tagHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes([history.sourceBoundaryCommit]));
  });

  test("merge-history source shallow + annotated boundary tag 下显式 tag-only refSpecs 的 shallow-exclude follow-up 会像 bare git CLI 一样拒绝且保持 tag/shallow 状态不变", async () => {
    await server.stop();
    await createTaggedMergeShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "merge-tagged-source-tag-only-refspec.git",
      upstreamName: "merge-tagged-upstream-tag-only-refspec.git",
      workName: "merge-tagged-upstream-work-tag-only-refspec",
      tagName: "tag-boundary",
      tagTarget: "topic-boundary",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-tagged-source-tag-only-refspec.git");

    const bareCliDir = join(tempDir, "cli-merge-source-tag-only-refspec.git");
    const nanoDir = join(tempDir, "nano-merge-source-tag-only-refspec.git");
    const repo = initRepository(nanoDir);
    const refSpecs = ["refs/tags/*:refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    await repo.fetch(server.url, { refSpecs, depth: 1 });
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--depth=1",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );

    const tagHash = repo.refs.read("refs/tags/tag-boundary");
    expect(tagHash).not.toBeNull();
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { refSpecs, shallowExclude: ["tag-boundary"] });
    expect(nanoFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--shallow-exclude=tag-boundary",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    expect(cliFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(nanoBatches).toHaveLength(1);
    const firstBatch = nanoBatches[0] ?? [];
    expect(getNonHaveLines(firstBatch)).toEqual([
      "command=fetch",
      "object-format=sha1",
      "thin-pack",
      "no-progress",
      "include-tag",
      "ofs-delta",
      ...sortHashes(repo.shallow.read()).map((oid) => `shallow ${oid}`),
      "deepen-not tag-boundary",
      `want ${tagHash}`,
    ]);
    expect(sortHashes(getHaveLines(firstBatch))).toEqual(
      sortHashes(repo.shallow.read().map((oid) => `have ${oid}`)),
    );
    expect(repo.refs.read("refs/tags/tag-boundary")).toBe(tagHash);
    expect(sortHashes(repo.shallow.read())).toEqual(sortHashes(readBareShallowFile(bareCliDir)));
  });

  test("source shallow + noTags + 显式 tag-only refPatterns 的初始 full fetch 会像 bare git CLI 一样成功但不落地 tag", async () => {
    await server.stop();
    await createTaggedShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "annotated-tagged-source-no-tags-tag-only.git",
      upstreamName: "annotated-tagged-upstream-no-tags-tag-only.git",
      workName: "annotated-tagged-upstream-work-no-tags-tag-only",
      tagName: "tag-boundary",
    });
    server = startGitHttpBackendServer(tempDir, "/annotated-tagged-source-no-tags-tag-only.git");

    const bareCliDir = join(tempDir, "cli-source-no-tags-tag-only.git");
    const repo = initRepository(join(tempDir, "nano-source-no-tags-tag-only.git"));
    const refPatterns = ["refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { noTags: true, refPatterns });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(repo.shallow.read()).toEqual([]);
    expect(
      git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)", "refs/tags"], tempDir),
    ).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("merge-history source shallow + noTags + 显式 tag-only refPatterns 的初始 full fetch 会像 bare git CLI 一样成功但不落地 tag", async () => {
    await server.stop();
    await createTaggedMergeShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "merge-tagged-source-no-tags-tag-only.git",
      upstreamName: "merge-tagged-upstream-no-tags-tag-only.git",
      workName: "merge-tagged-upstream-work-no-tags-tag-only",
      tagName: "tag-boundary",
      tagTarget: "topic-boundary",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-tagged-source-no-tags-tag-only.git");

    const bareCliDir = join(tempDir, "cli-merge-source-no-tags-tag-only.git");
    const repo = initRepository(join(tempDir, "nano-merge-source-no-tags-tag-only.git"));
    const refPatterns = ["refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { noTags: true, refPatterns });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(repo.shallow.read()).toEqual([]);
    expect(
      git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)", "refs/tags"], tempDir),
    ).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("source shallow + noTags + 显式 heads+tags refPatterns 的初始 full fetch 会像 bare git CLI 一样拒绝且不落地 refs", async () => {
    await server.stop();
    await createTaggedShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "annotated-tagged-source-no-tags-heads-tags.git",
      upstreamName: "annotated-tagged-upstream-no-tags-heads-tags.git",
      workName: "annotated-tagged-upstream-work-no-tags-heads-tags",
      tagName: "tag-boundary",
    });
    server = startGitHttpBackendServer(tempDir, "/annotated-tagged-source-no-tags-heads-tags.git");

    const bareCliDir = join(tempDir, "cli-source-no-tags-heads-tags.git");
    const repo = initRepository(join(tempDir, "nano-source-no-tags-heads-tags.git"));
    const refPatterns = ["refs/heads/*", "refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { noTags: true, refPatterns });
    expect(nanoFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        "refs/heads/*:refs/heads/*",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );
    expect(cliFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.readBranch("main")).toBeNull();
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("merge-history source shallow + noTags + 显式 heads+tags refPatterns 的初始 full fetch 会像 bare git CLI 一样拒绝且不落地 refs", async () => {
    await server.stop();
    await createTaggedMergeShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "merge-tagged-source-no-tags-heads-tags.git",
      upstreamName: "merge-tagged-upstream-no-tags-heads-tags.git",
      workName: "merge-tagged-upstream-work-no-tags-heads-tags",
      tagName: "tag-boundary",
      tagTarget: "topic-boundary",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-tagged-source-no-tags-heads-tags.git");

    const bareCliDir = join(tempDir, "cli-merge-source-no-tags-heads-tags.git");
    const repo = initRepository(join(tempDir, "nano-merge-source-no-tags-heads-tags.git"));
    const refPatterns = ["refs/heads/*", "refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { noTags: true, refPatterns });
    expect(nanoFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        "refs/heads/*:refs/heads/*",
        "refs/tags/*:refs/tags/*",
      ],
      tempDir,
      15000,
    );
    expect(cliFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.readBranch("main")).toBeNull();
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("source shallow + noTags + 显式 tag-only refSpecs 的初始 full fetch 会像 bare git CLI 一样成功但不落地 tag", async () => {
    await server.stop();
    await createTaggedShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "annotated-tagged-source-no-tags-tag-only-refspecs.git",
      upstreamName: "annotated-tagged-upstream-no-tags-tag-only-refspecs.git",
      workName: "annotated-tagged-upstream-work-no-tags-tag-only-refspecs",
      tagName: "tag-boundary",
    });
    server = startGitHttpBackendServer(
      tempDir,
      "/annotated-tagged-source-no-tags-tag-only-refspecs.git",
    );

    const bareCliDir = join(tempDir, "cli-source-no-tags-tag-only-refspecs.git");
    const repo = initRepository(join(tempDir, "nano-source-no-tags-tag-only-refspecs.git"));
    const refSpecs = ["refs/tags/*:refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { noTags: true, refSpecs });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(repo.shallow.read()).toEqual([]);
    expect(
      git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)", "refs/tags"], tempDir),
    ).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("merge-history source shallow + noTags + 显式 tag-only refSpecs 的初始 full fetch 会像 bare git CLI 一样成功但不落地 tag", async () => {
    await server.stop();
    await createTaggedMergeShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "merge-tagged-source-no-tags-tag-only-refspecs.git",
      upstreamName: "merge-tagged-upstream-no-tags-tag-only-refspecs.git",
      workName: "merge-tagged-upstream-work-no-tags-tag-only-refspecs",
      tagName: "tag-boundary",
      tagTarget: "topic-boundary",
    });
    server = startGitHttpBackendServer(
      tempDir,
      "/merge-tagged-source-no-tags-tag-only-refspecs.git",
    );

    const bareCliDir = join(tempDir, "cli-merge-source-no-tags-tag-only-refspecs.git");
    const repo = initRepository(join(tempDir, "nano-merge-source-no-tags-tag-only-refspecs.git"));
    const refSpecs = ["refs/tags/*:refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { noTags: true, refSpecs });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(repo.shallow.read()).toEqual([]);
    expect(
      git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)", "refs/tags"], tempDir),
    ).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("source shallow + noTags + 显式 heads+tags refSpecs 的初始 full fetch 会像 bare git CLI 一样拒绝且不落地 refs", async () => {
    await server.stop();
    await createTaggedShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "annotated-tagged-source-no-tags-heads-tags-refspecs.git",
      upstreamName: "annotated-tagged-upstream-no-tags-heads-tags-refspecs.git",
      workName: "annotated-tagged-upstream-work-no-tags-heads-tags-refspecs",
      tagName: "tag-boundary",
    });
    server = startGitHttpBackendServer(
      tempDir,
      "/annotated-tagged-source-no-tags-heads-tags-refspecs.git",
    );

    const bareCliDir = join(tempDir, "cli-source-no-tags-heads-tags-refspecs.git");
    const repo = initRepository(join(tempDir, "nano-source-no-tags-heads-tags-refspecs.git"));
    const refSpecs = ["refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { noTags: true, refSpecs });
    expect(nanoFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    expect(cliFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.readBranch("main")).toBeNull();
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("merge-history source shallow + noTags + 显式 heads+tags refSpecs 的初始 full fetch 会像 bare git CLI 一样拒绝且不落地 refs", async () => {
    await server.stop();
    await createTaggedMergeShallowSourceRepository(tempDir, {
      annotated: true,
      repoName: "merge-tagged-source-no-tags-heads-tags-refspecs.git",
      upstreamName: "merge-tagged-upstream-no-tags-heads-tags-refspecs.git",
      workName: "merge-tagged-upstream-work-no-tags-heads-tags-refspecs",
      tagName: "tag-boundary",
      tagTarget: "topic-boundary",
    });
    server = startGitHttpBackendServer(
      tempDir,
      "/merge-tagged-source-no-tags-heads-tags-refspecs.git",
    );

    const bareCliDir = join(tempDir, "cli-merge-source-no-tags-heads-tags-refspecs.git");
    const repo = initRepository(join(tempDir, "nano-merge-source-no-tags-heads-tags-refspecs.git"));
    const refSpecs = ["refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoFetch = repo.fetch(server.url, { noTags: true, refSpecs });
    expect(nanoFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([nanoFetch]);
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    const cliFetch = gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    expect(cliFetch).rejects.toBeInstanceOf(Error);
    await Promise.allSettled([cliFetch]);
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.readBranch("main")).toBeNull();
    expect(repo.refs.list("refs/tags/")).toEqual([]);
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("source shallow + noTags + 显式 custom namespace refSpec 的初始 full fetch 会像 bare git CLI 一样成功但跳过 ref 更新", async () => {
    await server.stop();
    await createShallowSourceRepository(tempDir, {
      repoName: "plain-shallow-source-no-tags-custom-refspec.git",
      upstreamName: "plain-upstream-no-tags-custom-refspec.git",
      workName: "plain-upstream-work-no-tags-custom-refspec",
    });
    server = startGitHttpBackendServer(tempDir, "/plain-shallow-source-no-tags-custom-refspec.git");

    const bareCliDir = join(tempDir, "cli-source-no-tags-custom-refspec.git");
    const repo = initRepository(join(tempDir, "nano-source-no-tags-custom-refspec.git"));
    const refSpecs = ["refs/heads/main:refs/remotes/origin/main"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { noTags: true, refSpecs });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("merge-history source shallow + noTags + 显式 custom namespace refSpec 的初始 full fetch 会像 bare git CLI 一样成功但跳过 ref 更新", async () => {
    await server.stop();
    await createMergeShallowSourceRepository(tempDir, {
      repoName: "merge-shallow-source-no-tags-custom-refspec.git",
      upstreamName: "merge-upstream-no-tags-custom-refspec.git",
      workName: "merge-upstream-work-no-tags-custom-refspec",
    });
    server = startGitHttpBackendServer(tempDir, "/merge-shallow-source-no-tags-custom-refspec.git");

    const bareCliDir = join(tempDir, "cli-merge-source-no-tags-custom-refspec.git");
    const repo = initRepository(join(tempDir, "nano-merge-source-no-tags-custom-refspec.git"));
    const refSpecs = ["refs/heads/main:refs/remotes/origin/main"];

    git(["init", "--bare", bareCliDir], tempDir);
    git(["--git-dir", bareCliDir, "remote", "add", "origin", server.url], tempDir);

    server.clearRequests();
    const nanoResult = await repo.fetch(server.url, { noTags: true, refSpecs });
    const nanoBatches = getNormalizedFetchCommandBatches(server.requests);

    server.clearRequests();
    await gitWithTimeout(
      [
        "--git-dir",
        bareCliDir,
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "origin",
        ...refSpecs,
      ],
      tempDir,
      15000,
    );
    const cliBatches = getNormalizedFetchCommandBatches(server.requests);

    expect(nanoResult.objectCount).toBeGreaterThanOrEqual(0);
    expect(nanoBatches).toEqual(cliBatches);
    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();
    expect(repo.shallow.read()).toEqual([]);
    expect(git(["--git-dir", bareCliDir, "for-each-ref", "--format=%(refname)"], tempDir)).toBe("");
    expect(readBareShallowFile(bareCliDir)).toEqual([]);
  });

  test("远端分支可镜像到自定义命名空间", async () => {
    git(["checkout", "-b", "feature"], workDir);
    createFile(workDir, "feature.txt", "feature branch\n");
    git(["add", "feature.txt"], workDir);
    git(["commit", "-m", "Add feature branch"], workDir);
    const featureCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "feature"], workDir);

    const repo = initRepository(localDir);
    const session = await repo.openImportSession({ url: server.url });

    await applyDraft(
      session
        .plan()
        .materialize(session.select("refs/heads/*"))
        .toNamespace("refs/mirrors/upstream/*", {
          policy: { mode: "mirror" },
          prune: true,
        }),
    );

    expect(repo.refs.read("refs/mirrors/upstream/main")).toBe(mainCommitHash);
    expect(repo.refs.read("refs/mirrors/upstream/feature")).toBe(featureCommitHash);
    expect(repo.refs.read("refs/heads/main")).toBeNull();
  });

  test("远端 tag 可导入到本地 refs/tags/*", async () => {
    git(["checkout", "main"], workDir);
    git(["tag", "v1.0.0", mainCommitHash], workDir);
    git(["push", repoDir, "refs/tags/v1.0.0"], workDir);

    const repo = initRepository(localDir);
    const session = await repo.openImportSession({ url: server.url });

    await applyDraft(
      session.plan().materialize(session.select("refs/tags/*")).toNamespace("refs/tags/*"),
    );

    expect(repo.refs.read("refs/tags/v1.0.0")).toBe(mainCommitHash);
    expect(git(["tag", "--list"], localDir)).toContain("v1.0.0");
  });

  test("ownership/prune 会删除命名空间中的陈旧 refs", async () => {
    const repo = initRepository(localDir);
    repo.refs.write("refs/mirrors/upstream/stale", mainCommitHash);

    const session = await repo.openImportSession({ url: server.url });
    const result = await applyDraft(
      session
        .plan()
        .materialize(session.select("refs/heads/*"))
        .toNamespace("refs/mirrors/upstream/*", {
          policy: { mode: "mirror" },
          prune: true,
        }),
    );

    expect(result.deletedRefs).toContain("refs/mirrors/upstream/stale");
    expect(repo.refs.read("refs/mirrors/upstream/stale")).toBeNull();
    expect(repo.refs.read("refs/mirrors/upstream/main")).toBe(mainCommitHash);
  });

  test("ownership/prune 也会删除 packed-refs 中的陈旧引用", async () => {
    const repo = initRepository(localDir);
    repo.refs.write("refs/mirrors/upstream/stale", mainCommitHash);
    git(["pack-refs", "--all"], localDir);

    const session = await repo.openImportSession({ url: server.url });
    const result = await applyDraft(
      session
        .plan()
        .materialize(session.select("refs/heads/*"))
        .toNamespace("refs/mirrors/upstream/*", {
          policy: { mode: "mirror" },
          prune: true,
        }),
    );

    expect(result.deletedRefs).toContain("refs/mirrors/upstream/stale");
    expect(repo.refs.read("refs/mirrors/upstream/stale")).toBeNull();
  });

  test("preview 后本地相关 ref 漂移会导致 apply 失败", async () => {
    const repo = initRepository(localDir);
    const session = await repo.openImportSession({ url: server.url });

    const plan = session.plan().materialize(session.defaultBranch()).toBranch("main");
    const prepared = await prepareDraft(plan);
    const preview = prepared.preview;

    expect(preview.canApply).toBe(true);

    repo.refs.write("refs/heads/main", mainCommitHash);

    expect(prepared.apply()).rejects.toThrow(/前置条件/);
  });

  test("自定义命名空间未显式声明策略时拒绝执行", async () => {
    const repo = initRepository(localDir);
    const session = await repo.openImportSession({ url: server.url });

    const plan = session.plan().materialize(session.allRefs()).toNamespace("refs/vendor/*");
    const preview = await previewDraft(plan);

    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (diagnostic) =>
          diagnostic.level === "error" && diagnostic.message.includes("需要显式指定 policy"),
      ),
    ).toBe(true);

    expect(applyDraft(plan)).rejects.toThrow(/无法执行/);
  });

  test("setHead 不能绑定到镜像命名空间", async () => {
    const repo = initRepository(localDir);
    const session = await repo.openImportSession({ url: server.url });
    const defaultBranch = session.defaultBranch();

    const preview = await previewDraft(
      session
        .plan()
        .materialize(defaultBranch)
        .toNamespace("refs/mirrors/upstream/*", {
          policy: { mode: "mirror" },
        })
        .materialize(defaultBranch)
        .setHead(),
    );

    expect(preview.headOperation).toBeUndefined();
    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (diagnostic) =>
          diagnostic.level === "error" &&
          diagnostic.message.includes("setHead() 只能指向 refs/heads/*"),
      ),
    ).toBe(true);
  });

  test("setHead 不能绑定到 tag 物化结果", async () => {
    git(["checkout", "main"], workDir);
    git(["tag", "v1.0.0", mainCommitHash], workDir);
    git(["push", repoDir, "refs/tags/v1.0.0"], workDir);

    const repo = initRepository(localDir);
    const session = await repo.openImportSession({ url: server.url });
    const tags = session.select("refs/tags/*");

    const preview = await previewDraft(
      session
        .plan()
        .materialize(tags)
        .toTag("stable-v1")
        .materialize(tags.where((ref) => ref.name === "refs/tags/v1.0.0"))
        .setHead(),
    );

    expect(preview.headOperation).toBeUndefined();
    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (diagnostic) =>
          diagnostic.level === "error" &&
          diagnostic.message.includes("setHead() 只能指向 refs/heads/*"),
      ),
    ).toBe(true);
  });
});
