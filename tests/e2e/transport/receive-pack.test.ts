/**
 * v1 receive-pack 端到端测试
 *
 * 通过 Bun.serve + createSmartHttpHandler 启动 nano-git 服务端，
 * 使用标准 git CLI 验证 serveV1Advertise 与 handleV1ReceivePush 的
 * 完整 HTTP 协议流程。
 *
 * 与 tests/units/transport/v1/receive-pack.test.ts 的区别：
 * - 单元测试：直接调用函数，验证函数行为
 * - 端到端测试：通过真实 HTTP 请求 + git CLI 验证协议兼容性
 *
 * 测试场景：
 * 1. serveV1Advertise: HTTP GET 获取 ref advertisement
 * 2. handleV1ReceivePush: git CLI 推送新分支、快进更新、删除、强制更新
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { git, gitWithTimeout, createTempDir, cleanupDir, FIXED_AUTHOR } from "../helpers.ts";
import { startNanoGitServer, createDefaultBackend } from "./nano-git-server.ts";
import { createMemoryRepositoryBackend } from "@/backend/index.ts";
import { sha1, type SHA1 } from "@/core/types.ts";

import type { NanoGitServer } from "./nano-git-server.ts";

// ============================================================================
// 常量
// ============================================================================

/** git 命令统一超时（毫秒） */
const GIT_TIMEOUT_MS = 15000;

/**
 * 强制 git 使用 v1 协议的参数（仅用于 push）
 *
 * nano-git 的 receive-pack 仅支持 Git Wire 协议 v1。
 */
const GIT_V1_PUSH_ARGS = ["-c", "protocol.version=1", "push"];

/** git v2 参数（用于 clone 等 upload-pack 操作） */
const GIT_V2_CLONE_ARGS = ["-c", "protocol.version=2", "clone"];

// ============================================================================
// serveV1Advertise — 通过 HTTP 验证
// ============================================================================

describe("serveV1Advertise", () => {
  let server: NanoGitServer;
  let tempDir: string;

  beforeEach(() => {
    server = startNanoGitServer();
    tempDir = createTempDir("e2e-serve-advertise");
  });

  afterEach(() => {
    server.stop();
    cleanupDir(tempDir);
  });

  test("GET /info/refs?service=git-receive-pack 返回 v1 广告", async () => {
    const resp = await fetch(`${server.url}/info/refs?service=git-receive-pack`);

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/x-git-receive-pack-advertisement");

    const text = await resp.text();

    expect(text).toContain("# service=git-receive-pack");
    expect(text).toContain("report-status");
    expect(text).toContain("side-band-64k");
    expect(text).toContain("ofs-delta");
    expect(text).toContain("delete-refs");
    expect(text).toContain("agent=nano-git");
    expect(text).toContain("refs/heads/main");
  });

  test("空仓库返回 capabilities 占位行（无 ref）", async () => {
    const emptyBackend = createMemoryRepositoryBackend({
      initialRefs: new Map(),
    });
    const emptyServer = startNanoGitServer(emptyBackend);

    try {
      const resp = await fetch(`${emptyServer.url}/info/refs?service=git-receive-pack`);
      const text = await resp.text();

      expect(text).toContain("capabilities^{}");
      expect(text).toContain("report-status");
      expect(text).toContain("delete-refs");
    } finally {
      emptyServer.stop();
    }
  });

  test("带 annotated tag 的仓库返回 peeled 行", async () => {
    const backend = createDefaultBackend();
    const mainHash = backend.refs.read("refs/heads/main")! as SHA1;
    const tagHash = backend.objects.write({
      type: "tag",
      object: mainHash,
      objectType: "commit",
      tag: "v1.0",
      tagger: { name: "T", email: "t@t", timestamp: 0, timezone: "+0000" },
      message: "v1.0\n",
    });
    backend.refs.write("refs/tags/v1.0", tagHash);

    const tagServer = startNanoGitServer(backend);
    try {
      const resp = await fetch(`${tagServer.url}/info/refs?service=git-receive-pack`);
      const text = await resp.text();

      expect(text).toContain(`refs/tags/v1.0`);
      expect(text).toContain(`refs/tags/v1.0^{}`);
    } finally {
      tagServer.stop();
    }
  });
});

// ============================================================================
// handleV1ReceivePush — 通过 git CLI 推送验证
//
// 说明：本地 git 操作（init, add, commit, rev-parse）使用同步的 git() 函数，
//       涉及 HTTP 协议的远程操作（push, clone）使用异步的 gitWithTimeout()。
// ============================================================================

describe("handleV1ReceivePush", () => {
  let server: NanoGitServer;
  let tempDir: string;

  beforeEach(() => {
    server = startNanoGitServer();
    tempDir = createTempDir("e2e-handle-push");
  });

  afterEach(() => {
    server.stop();
    cleanupDir(tempDir);
  });

  /**
   * 在指定目录用系统 git 初始化仓库并创建初始提交
   *
   * 注意：需要先创建目录再调用 git init -b main，因为 Bun 的 spawnSync 在
   * Bun.serve 运行时对不存在的目标目录有 bug（返回 status: undefined）。
   */
  function initRepo(dir: string, file: string, content: string, msg: string): string {
    mkdirSync(dir, { recursive: true });
    git(["init", "-b", "main"], dir);
    writeFileSync(join(dir, file), content);
    git(["add", file], dir);
    git(
      [
        "-c",
        `user.name=${FIXED_AUTHOR.name}`,
        "-c",
        `user.email=${FIXED_AUTHOR.email}`,
        "commit",
        "-m",
        msg,
      ],
      dir,
    );
    return git(["rev-parse", "HEAD"], dir);
  }

  test("推送新分支到服务端（新建 ref）", async () => {
    const workDir = join(tempDir, "push-new-branch");
    const commitHash = initRepo(workDir, "README.md", "# New Feature\n", "feat: new feature");

    await gitWithTimeout(
      [...GIT_V1_PUSH_ARGS, server.url, "HEAD:refs/heads/new-branch"],
      workDir,
      GIT_TIMEOUT_MS,
    );

    // 验证服务端 ref 已创建
    const serverRef = server.backend.refs.read("refs/heads/new-branch");
    expect(serverRef).toBe(commitHash);

    // 验证对象已解包到服务端存储
    expect(server.backend.objects.exists(sha1(commitHash))).toBe(true);
  });

  test("克隆后快进推送更新已有分支", async () => {
    // 克隆服务端仓库
    const cloneDir = join(tempDir, "cloned");
    await gitWithTimeout([...GIT_V2_CLONE_ARGS, server.url, cloneDir], tempDir, GIT_TIMEOUT_MS);

    const oldHash = server.backend.refs.read("refs/heads/main");
    expect(oldHash).not.toBeNull();

    // 在克隆仓库中创建新提交（用同步 git 做本地操作）
    writeFileSync(join(cloneDir, "UPDATE.md"), "# Update\n");
    git(["add", "UPDATE.md"], cloneDir);
    git(
      [
        "-c",
        `user.name=${FIXED_AUTHOR.name}`,
        "-c",
        `user.email=${FIXED_AUTHOR.email}`,
        "commit",
        "-m",
        "update",
      ],
      cloneDir,
    );
    const newCommitHash = git(["rev-parse", "HEAD"], cloneDir);

    // 推送回服务端（快进更新）
    await gitWithTimeout([...GIT_V1_PUSH_ARGS, "origin", "main"], cloneDir, GIT_TIMEOUT_MS);

    // 验证服务端 ref 已被快进更新
    const newHash = server.backend.refs.read("refs/heads/main");
    expect(newHash).toBe(newCommitHash);

    // 验证对象已解包
    expect(server.backend.objects.exists(newCommitHash as SHA1)).toBe(true);
  });

  test("推送多个分支到服务端", async () => {
    const workDir = join(tempDir, "push-multi");

    // 创建第一个分支
    initRepo(workDir, "a.txt", "a\n", "commit a");
    await gitWithTimeout(
      [...GIT_V1_PUSH_ARGS, server.url, "HEAD:refs/heads/branch-a"],
      workDir,
      GIT_TIMEOUT_MS,
    );

    // 创建第二个提交并推送为新分支
    writeFileSync(join(workDir, "b.txt"), "b\n");
    git(["add", "b.txt"], workDir);
    git(
      [
        "-c",
        `user.name=${FIXED_AUTHOR.name}`,
        "-c",
        `user.email=${FIXED_AUTHOR.email}`,
        "commit",
        "-m",
        "commit b",
      ],
      workDir,
    );
    await gitWithTimeout(
      [...GIT_V1_PUSH_ARGS, server.url, "HEAD:refs/heads/branch-b"],
      workDir,
      GIT_TIMEOUT_MS,
    );

    // 验证两个分支都存在于服务端
    expect(server.backend.refs.read("refs/heads/branch-a")).not.toBeNull();
    expect(server.backend.refs.read("refs/heads/branch-b")).not.toBeNull();
  });

  test("删除远程分支", async () => {
    const workDir = join(tempDir, "delete-branch");

    // 先推送一个分支作为待删除目标
    initRepo(workDir, "temp.md", "# Temp\n", "temporary commit");
    await gitWithTimeout(
      [...GIT_V1_PUSH_ARGS, server.url, "HEAD:refs/heads/to-delete"],
      workDir,
      GIT_TIMEOUT_MS,
    );
    expect(server.backend.refs.read("refs/heads/to-delete")).not.toBeNull();

    // 删除远程分支（使用 :<ref> 语法）
    await gitWithTimeout(
      ["-c", "protocol.version=1", "push", server.url, ":refs/heads/to-delete"],
      workDir,
      GIT_TIMEOUT_MS,
    );

    // 验证分支已被删除
    expect(server.backend.refs.read("refs/heads/to-delete")).toBeNull();
  });

  test("强制推送覆盖已有分支", async () => {
    const workDir = join(tempDir, "force-push");

    // 创建初始分支并推送到服务端
    const firstHash = initRepo(workDir, "OLD.md", "# Old\n", "old commit");
    await gitWithTimeout(
      [...GIT_V1_PUSH_ARGS, server.url, "HEAD:refs/heads/force-test"],
      workDir,
      GIT_TIMEOUT_MS,
    );
    expect(server.backend.refs.read("refs/heads/force-test")).toBe(firstHash);

    // 创建无关联的提交（通过 --amend 改变父指针，制造非快进场景）
    writeFileSync(join(workDir, "OLD.md"), "# Changed\n");
    git(["add", "OLD.md"], workDir);
    git(
      [
        "-c",
        `user.name=${FIXED_AUTHOR.name}`,
        "-c",
        `user.email=${FIXED_AUTHOR.email}`,
        "commit",
        "--amend",
        "-m",
        "amended",
      ],
      workDir,
    );
    const amendedHash = git(["rev-parse", "HEAD"], workDir);

    // --force 推送到已有分支（非快进更新）
    await gitWithTimeout(
      ["-c", "protocol.version=1", "push", "--force", server.url, "HEAD:refs/heads/force-test"],
      workDir,
      GIT_TIMEOUT_MS,
    );

    // 验证服务端 ref 已被强制更新
    const updatedHash = server.backend.refs.read("refs/heads/force-test");
    expect(updatedHash).toBe(amendedHash);
  });
});

// ============================================================================
// 空仓库 receive-pack 端到端
// ============================================================================

describe("空仓库 receive-pack", () => {
  let emptyServer: NanoGitServer;
  let tempDir: string;

  beforeEach(() => {
    const emptyBackend = createMemoryRepositoryBackend({
      initialRefs: new Map(),
    });
    emptyServer = startNanoGitServer(emptyBackend);
    tempDir = createTempDir("e2e-receive-pack-empty");
  });

  afterEach(() => {
    emptyServer.stop();
    cleanupDir(tempDir);
  });

  test("推送首个分支到空仓库", async () => {
    const workDir = join(tempDir, "first-push");

    // 先创建目录（Bun bug 规避：Bun.serve + spawnSync 对不存在目录有问题）
    mkdirSync(workDir, { recursive: true });

    // 用同步 git 创建本地仓库和提交
    git(["init", "-b", "main"], workDir);
    writeFileSync(join(workDir, "FIRST.md"), "# First\n");
    git(["add", "FIRST.md"], workDir);
    git(
      [
        "-c",
        `user.name=${FIXED_AUTHOR.name}`,
        "-c",
        `user.email=${FIXED_AUTHOR.email}`,
        "commit",
        "-m",
        "first push to empty repo",
      ],
      workDir,
    );
    const commitHash = git(["rev-parse", "HEAD"], workDir);

    // 用异步 gitWithTimeout 推送到服务端（涉及 HTTP）
    await gitWithTimeout(
      [...GIT_V1_PUSH_ARGS, emptyServer.url, "HEAD:refs/heads/main"],
      workDir,
      GIT_TIMEOUT_MS,
    );

    // 验证 ref 已创建
    const serverRef = emptyServer.backend.refs.read("refs/heads/main");
    expect(serverRef).toBe(commitHash);

    // 验证对象已解包到服务端存储
    expect(emptyServer.backend.objects.exists(sha1(commitHash))).toBe(true);
  });
});
