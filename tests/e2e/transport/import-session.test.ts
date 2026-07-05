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

function sortHashes(hashes: readonly string[]): string[] {
  return [...hashes].sort();
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
  const sourceBoundaryCommit = git(["rev-parse", "HEAD"], workDir);

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

  const tipCommit = git(["--git-dir", shallowBareDir, "rev-parse", "refs/heads/main"], rootDir);
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
  const sourceBoundaryCommit = git(["rev-parse", "HEAD"], workDir);
  createFile(workDir, "c4.txt", "c4\n");
  git(["add", "c4.txt"], workDir);
  git(["commit", "-m", "c4"], workDir);
  git(["push", "-u", "origin", "main"], workDir);
  git(["clone", "--bare", "--depth=2", `file://${upstreamBareDir}`, shallowBareDir], rootDir);

  const tipCommit = git(["--git-dir", shallowBareDir, "rev-parse", "refs/heads/main"], rootDir);
  return { shallowBareDir, sourceBoundaryCommit, tipCommit };
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
