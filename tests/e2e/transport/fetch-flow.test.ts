/**
 * 完整 Fetch 流程测试
 *
 * 验证从零 clone、增量 fetch、shallow fetch 等完整 fetch 场景。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { git, gitInit, createTempDir, cleanupDir, createFile } from "../helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { sha1 } from "@/core/types.ts";
import { initRepository } from "@/repository/index.ts";
import { encodeFlushPkt, encodePktLine, parsePktLines } from "@/transport/pkt-line.ts";

import type { GitHttpBackendResponse, GitHttpRequestRecord } from "./http-server.ts";

function stripCapabilityFromAdvertisement(
  response: GitHttpBackendResponse,
  capability: string,
): GitHttpBackendResponse {
  const lines = parsePktLines(response.body);
  const chunks: Buffer[] = [];
  let rewritten = false;

  for (const line of lines) {
    if (line.type === "flush") {
      chunks.push(encodeFlushPkt());
      continue;
    }

    if (line.type !== "data") {
      continue;
    }

    if (!rewritten) {
      const nullIndex = line.payload.indexOf(0);
      if (nullIndex !== -1) {
        const refPart = line.payload.subarray(0, nullIndex);
        const caps = line.payload
          .subarray(nullIndex + 1)
          .toString("utf-8")
          .split(" ")
          .filter((token) => token.length > 0 && token !== capability);
        const payload = Buffer.concat([
          refPart,
          Buffer.from([0]),
          Buffer.from(caps.join(" "), "utf-8"),
        ]);
        chunks.push(encodePktLine(payload));
        rewritten = true;
        continue;
      }
    }

    chunks.push(encodePktLine(line.payload));
  }

  return {
    ...response,
    body: Buffer.concat(chunks),
  };
}

describe("完整 fetch 流程", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-full-fetch");

    // 1. 创建服务端裸仓库
    serverRepoDir = join(tempDir, "server.git");
    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);

    // 2. 创建并推送提交
    workDir = join(tempDir, "work");
    gitInit(workDir);
    createFile(workDir, "README.md", "# Hello\n");
    createFile(workDir, "src/index.js", 'console.log("hello");\n');
    git(["add", "README.md", "src/index.js"], workDir);
    git(["commit", "-m", "Initial commit"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    // 创建第二个提交
    createFile(workDir, "src/lib.js", "module.exports = {}\n");
    git(["add", "src/lib.js"], workDir);
    git(["commit", "-m", "Add lib"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    // 3. 启动 HTTP 服务器代理 git http-backend
    server = startGitHttpBackendServer(tempDir, "/server.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("初始 clone", async () => {
    const localDir = join(tempDir, "local");
    const repo = initRepository(localDir);

    const result = await repo.fetch(serverUrl);

    expect(result.objectCount).toBeGreaterThan(0);

    const mainRef = repo.refs.readRaw("refs/remotes/origin/main");
    expect(mainRef).not.toBeNull();
    expect(mainRef!.length).toBe(40);

    const headRef = repo.refs.readRaw("HEAD");
    expect(headRef).not.toBeNull();

    const commitObj = repo.objects.read(sha1(mainRef!));
    expect(commitObj.type).toBe("commit");
  });

  test("增量 fetch：已存在对象时不重复拉取", async () => {
    const localDir = join(tempDir, "local2");
    const repo = initRepository(localDir);

    const result1 = await repo.fetch(serverUrl);
    expect(result1.objectCount).toBeGreaterThan(0);

    const result2 = await repo.fetch(serverUrl);
    expect(result2.objectCount).toBe(0);
    expect(result2.fetchedRefs.size).toBe(0);
  });

  test("shallow fetch：depth=1 应成功完成初始拉取", async () => {
    const localDir = join(tempDir, "local-shallow");
    const repo = initRepository(localDir);

    const result = await repo.fetch(serverUrl, { depth: 1 });

    expect(result.objectCount).toBeGreaterThan(0);
    expect(repo.refs.readRaw("refs/remotes/origin/main")).not.toBeNull();
  });

  test("增量 fetch：本地通过其他 ref 持有目标 commit 时不重复下载", async () => {
    const localDir = join(tempDir, "local-multi-ref");
    const repo = initRepository(localDir);

    // 1. 初始 fetch：获取 main 的 2 个提交
    const result1 = await repo.fetch(serverUrl);
    expect(result1.objectCount).toBeGreaterThan(0);

    const oldMainHash = repo.refs.readRaw("refs/remotes/origin/main")!;

    // 2. 在服务端创建 feature 分支并推一个新提交
    const workDir = join(tempDir, "work-feature");
    git(["clone", serverRepoDir, workDir], tempDir);
    createFile(workDir, "feature.txt", "feature content\n");
    git(["add", "feature.txt"], workDir);
    git(["commit", "-m", "Feature commit"], workDir);
    const featureHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, `HEAD:feature`], workDir);

    // 3. 第二次 fetch：获取 feature 分支到本地
    const result2 = await repo.fetch(serverUrl);
    expect(result2.fetchedRefs.has("refs/remotes/origin/feature")).toBe(true);
    expect(repo.refs.readRaw("refs/remotes/origin/feature")).toBe(featureHash);
    expect(repo.refs.readRaw("refs/remotes/origin/main")).toBe(oldMainHash);

    // 4. 服务端将 main 快进到 feature 指向的同一个 commit
    git(["update-ref", "refs/heads/main", featureHash], serverRepoDir);

    // 5. 第三次 fetch：main 已前进到 feature commit，但该 commit 已在本地存储中
    const result3 = await repo.fetch(serverUrl);

    // BUG: 由于 have 列表只用了旧 refs/remotes/origin/main 而非所有本地 ref，
    //      导致 collectHaveCommits 没有遍历到 feature commit，
    //      服务端仍会重新发送 feature commit 的所有对象。
    // 修复后应为 0。
    expect(result3.objectCount).toBe(0);
    expect(result3.fetchedRefs.get("refs/remotes/origin/main")).toBe(sha1(featureHash));
  });

  test("空仓库 fetch：返回空结果且不写入 remote-tracking refs", async () => {
    const emptyRepoDir = join(tempDir, "empty-fetch.git");
    mkdirSync(emptyRepoDir);
    git(["init", "--bare"], emptyRepoDir);

    await using emptyServer = startGitHttpBackendServer(tempDir, "/empty-fetch.git");

    const localDir = join(tempDir, "local-empty-fetch");
    const repo = initRepository(localDir);
    const result = await repo.fetch(emptyServer.url);

    expect(result.objectCount).toBe(0);
    expect(result.fetchedRefs.size).toBe(0);
    expect(repo.refs.readRaw("refs/remotes/origin/main")).toBeNull();
  });

  test("显式 tag refspec：fetch 注解 tag 到本地 tags 命名空间", async () => {
    git(["tag", "-a", "v1.0", "-m", "release v1.0"], workDir);
    git(["push", serverRepoDir, "refs/tags/v1.0"], workDir);

    const localDir = join(tempDir, "local-tag-fetch");
    const repo = initRepository(localDir);

    const result = await repo.fetch(serverUrl, {
      refSpecs: ["+refs/tags/*:refs/tags/*"],
    });

    expect(result.objectCount).toBeGreaterThan(0);
    const tagHash = repo.refs.readRaw("refs/tags/v1.0");
    expect(tagHash).not.toBeNull();
    expect(repo.refs.readRaw("refs/remotes/origin/main")).toBeNull();

    const tagObject = repo.objects.read(sha1(tagHash!));
    expect(tagObject.type).toBe("tag");
  });

  test("tag-only 远端：默认 refspec fetch 返回空结果", async () => {
    git(["tag", "-a", "v-tag-only", "-m", "tag only"], workDir);
    git(["push", serverRepoDir, "refs/tags/v-tag-only"], workDir);
    git(["--git-dir", serverRepoDir, "update-ref", "-d", "refs/heads/main"], tempDir);

    const localDir = join(tempDir, "local-tag-only-default");
    const repo = initRepository(localDir);
    const result = await repo.fetch(serverUrl);

    expect(result.objectCount).toBe(0);
    expect(result.fetchedRefs.size).toBe(0);
    expect(repo.refs.readRaw("refs/remotes/origin/main")).toBeNull();
    expect(repo.refs.readRaw("refs/tags/v-tag-only")).toBeNull();
  });

  test("tag-only 远端：显式 tag refspec 仍可 fetch 注解 tag", async () => {
    git(["tag", "-a", "v-tag-only-fetch", "-m", "tag only fetch"], workDir);
    git(["push", serverRepoDir, "refs/tags/v-tag-only-fetch"], workDir);
    git(["--git-dir", serverRepoDir, "update-ref", "-d", "refs/heads/main"], tempDir);

    const localDir = join(tempDir, "local-tag-only-explicit");
    const repo = initRepository(localDir);
    const result = await repo.fetch(serverUrl, {
      refSpecs: ["+refs/tags/*:refs/tags/*"],
    });

    expect(result.objectCount).toBeGreaterThan(0);
    const tagHash = repo.refs.readRaw("refs/tags/v-tag-only-fetch");
    expect(tagHash).not.toBeNull();
    expect(repo.refs.readRaw("refs/remotes/origin/main")).toBeNull();
    expect(repo.objects.read(sha1(tagHash!)).type).toBe("tag");
  });

  test("协议降级：服务端不走 side-band-64k 时 fetch 仍成功", async () => {
    const downgradedServer = startGitHttpBackendServer(tempDir, "/server.git", undefined, {
      transformResponse(response: GitHttpBackendResponse, request: GitHttpRequestRecord) {
        if (
          request.method === "GET" &&
          request.path.endsWith("/info/refs") &&
          request.query === "service=git-upload-pack"
        ) {
          return stripCapabilityFromAdvertisement(response, "side-band-64k");
        }
        return response;
      },
    });

    await using serverHandle = downgradedServer;
    const localDir = join(tempDir, "local-raw-pack-fetch");
    const repo = initRepository(localDir);

    const result = await repo.fetch(serverHandle.url);

    expect(result.objectCount).toBeGreaterThan(0);
    const mainRef = repo.refs.readRaw("refs/remotes/origin/main");
    expect(mainRef).not.toBeNull();
    expect(repo.objects.read(sha1(mainRef!)).type).toBe("commit");
  });
});
