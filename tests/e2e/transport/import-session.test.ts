/**
 * Import Session 端到端测试
 *
 * 通过真实 git-http-backend 验证 advertisement、对象导入、
 * ref/HEAD 物化、ownership/prune 与前置条件漂移语义。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";

import { cleanupDir, createFile, createTempDir, git, gitFsck, gitRevParse } from "../helpers.ts";
import { createServerRepo } from "./helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { initRepository } from "@/repository/file.ts";
import { sha1 } from "@/types/index.ts";

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

    const preview = await plan.preview();
    expect(preview.canApply).toBe(true);
    expect(preview.prefetchedObjects).toBeGreaterThan(0);

    const result = await plan.apply();

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

  test("远端分支可镜像到自定义命名空间", async () => {
    git(["checkout", "-b", "feature"], workDir);
    createFile(workDir, "feature.txt", "feature branch\n");
    git(["add", "feature.txt"], workDir);
    git(["commit", "-m", "Add feature branch"], workDir);
    const featureCommitHash = sha1(git(["rev-parse", "HEAD"], workDir));
    git(["push", repoDir, "feature"], workDir);

    const repo = initRepository(localDir);
    const session = await repo.openImportSession({ url: server.url });

    await session
      .plan()
      .materialize(session.select("refs/heads/*"))
      .toNamespace("refs/mirrors/upstream/*", {
        policy: { mode: "mirror" },
        prune: true,
      })
      .apply();

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

    await session
      .plan()
      .materialize(session.select("refs/tags/*"))
      .toNamespace("refs/tags/*")
      .apply();

    expect(repo.refs.read("refs/tags/v1.0.0")).toBe(mainCommitHash);
    expect(git(["tag", "--list"], localDir)).toContain("v1.0.0");
  });

  test("ownership/prune 会删除命名空间中的陈旧 refs", async () => {
    const repo = initRepository(localDir);
    repo.refs.write("refs/mirrors/upstream/stale", mainCommitHash);

    const session = await repo.openImportSession({ url: server.url });
    const result = await session
      .plan()
      .materialize(session.select("refs/heads/*"))
      .toNamespace("refs/mirrors/upstream/*", {
        policy: { mode: "mirror" },
        prune: true,
      })
      .apply();

    expect(result.deletedRefs).toContain("refs/mirrors/upstream/stale");
    expect(repo.refs.read("refs/mirrors/upstream/stale")).toBeNull();
    expect(repo.refs.read("refs/mirrors/upstream/main")).toBe(mainCommitHash);
  });

  test("ownership/prune 也会删除 packed-refs 中的陈旧引用", async () => {
    const repo = initRepository(localDir);
    repo.refs.write("refs/mirrors/upstream/stale", mainCommitHash);
    git(["pack-refs", "--all"], localDir);

    const session = await repo.openImportSession({ url: server.url });
    const result = await session
      .plan()
      .materialize(session.select("refs/heads/*"))
      .toNamespace("refs/mirrors/upstream/*", {
        policy: { mode: "mirror" },
        prune: true,
      })
      .apply();

    expect(result.deletedRefs).toContain("refs/mirrors/upstream/stale");
    expect(repo.refs.read("refs/mirrors/upstream/stale")).toBeNull();
  });

  test("preview 后本地相关 ref 漂移会导致 apply 失败", async () => {
    const repo = initRepository(localDir);
    const session = await repo.openImportSession({ url: server.url });

    const plan = session.plan().materialize(session.defaultBranch()).toBranch("main");
    const preview = await plan.preview();

    expect(preview.canApply).toBe(true);

    repo.refs.write("refs/heads/main", mainCommitHash);

    expect(plan.apply()).rejects.toThrow(/前置条件/);
  });

  test("自定义命名空间未显式声明策略时拒绝执行", async () => {
    const repo = initRepository(localDir);
    const session = await repo.openImportSession({ url: server.url });

    const plan = session.plan().materialize(session.allRefs()).toNamespace("refs/vendor/*");
    const preview = await plan.preview();

    expect(preview.canApply).toBe(false);
    expect(
      preview.diagnostics.some(
        (diagnostic) =>
          diagnostic.level === "error" && diagnostic.message.includes("需要显式指定 policy"),
      ),
    ).toBe(true);

    expect(plan.apply()).rejects.toThrow(/无法执行/);
  });

  test("setHead 不能绑定到镜像命名空间", async () => {
    const repo = initRepository(localDir);
    const session = await repo.openImportSession({ url: server.url });
    const defaultBranch = session.defaultBranch();

    const preview = await session
      .plan()
      .materialize(defaultBranch)
      .toNamespace("refs/mirrors/upstream/*", {
        policy: { mode: "mirror" },
      })
      .materialize(defaultBranch)
      .setHead()
      .preview();

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

    const preview = await session
      .plan()
      .materialize(tags)
      .toTag("stable-v1")
      .materialize(tags.where((ref) => ref.name === "refs/tags/v1.0.0"))
      .setHead()
      .preview();

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
