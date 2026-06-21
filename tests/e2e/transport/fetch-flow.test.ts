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
  return rewriteAdvertisementCapabilities(response, (caps) =>
    caps.filter((token) => token.length > 0 && token !== capability),
  );
}

function rewriteAdvertisementCapabilities(
  response: GitHttpBackendResponse,
  rewrite: (capabilities: string[]) => string[],
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
        const originalCaps = line.payload
          .subarray(nullIndex + 1)
          .toString("utf-8")
          .split(" ")
          .filter((token) => token.length > 0);
        const caps = rewrite(originalCaps);
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

    const mainRef = repo.refs.read("refs/remotes/origin/main");
    expect(mainRef).not.toBeNull();
    expect(mainRef!.length).toBe(40);

    const headRef = repo.refs.read("HEAD");
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
    expect(repo.refs.read("refs/remotes/origin/main")).not.toBeNull();
  });

  test("增量 fetch：本地通过其他 ref 持有目标 commit 时不重复下载", async () => {
    const localDir = join(tempDir, "local-multi-ref");
    const repo = initRepository(localDir);

    // 1. 初始 fetch：获取 main 的 2 个提交
    const result1 = await repo.fetch(serverUrl);
    expect(result1.objectCount).toBeGreaterThan(0);

    const oldMainHash = repo.refs.read("refs/remotes/origin/main")!;

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
    expect(repo.refs.read("refs/remotes/origin/feature")).toBe(featureHash);
    expect(repo.refs.read("refs/remotes/origin/main")).toBe(oldMainHash);

    // 4. 服务端将 main 快进到 feature 指向的同一个 commit
    git(["update-ref", "refs/heads/main", featureHash], serverRepoDir);

    // 5. 第三次 fetch：main 已前进到 feature commit，但该 commit 已在本地存储中
    const result3 = await repo.fetch(serverUrl);

    // feature commit 已通过另一个本地 ref 持有，不应重复下载对象。
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
    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();
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
    const tagHash = repo.refs.read("refs/tags/v1.0");
    expect(tagHash).not.toBeNull();
    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();

    const tagObject = repo.objects.read(sha1(tagHash!));
    expect(tagObject.type).toBe("tag");
  });

  test("include-tag：默认 branch fetch 会顺带获取注解 tag 对象，但不会创建 tag ref", async () => {
    git(["tag", "-a", "v-include", "-m", "include tag"], workDir);
    git(["push", serverRepoDir, "refs/tags/v-include"], workDir);
    const remoteTagHash = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/tags/v-include"],
      tempDir,
    );

    const localDir = join(tempDir, "local-include-tag");
    const repo = initRepository(localDir);
    const result = await repo.fetch(serverUrl);

    expect(result.objectCount).toBeGreaterThan(0);
    expect(repo.refs.read("refs/remotes/origin/main")).not.toBeNull();
    expect(repo.refs.read("refs/tags/v-include")).toBeNull();
    expect(repo.objects.exists(sha1(remoteTagHash))).toBe(true);
    expect(repo.objects.read(sha1(remoteTagHash)).type).toBe("tag");
  });

  test("精确 refspec：混合 branches/tags 广告时只抓取指定 branch 与 tag", async () => {
    const featureDir = join(tempDir, "work-mixed-feature");
    git(["clone", serverRepoDir, featureDir], tempDir);
    createFile(featureDir, "feature.txt", "feature branch\n");
    git(["add", "feature.txt"], featureDir);
    git(["commit", "-m", "Feature branch commit"], featureDir);
    git(["push", serverRepoDir, "HEAD:refs/heads/feature"], featureDir);

    createFile(workDir, "main-second.txt", "main second\n");
    git(["add", "main-second.txt"], workDir);
    git(["commit", "-m", "Main second"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    git(["tag", "-a", "v-main-only", "-m", "main tag"], workDir);
    git(["push", serverRepoDir, "refs/tags/v-main-only"], workDir);

    git(["tag", "-a", "v-feature", "-m", "feature tag"], featureDir);
    git(["push", serverRepoDir, "refs/tags/v-feature"], featureDir);

    const localDir = join(tempDir, "local-exact-refspec-mixed");
    const repo = initRepository(localDir);
    const result = await repo.fetch(serverUrl, {
      refSpecs: [
        "+refs/heads/main:refs/remotes/origin/main",
        "+refs/tags/v-main-only:refs/tags/v-main-only",
      ],
    });

    expect(result.objectCount).toBeGreaterThan(0);
    expect(repo.refs.read("refs/remotes/origin/main")).not.toBeNull();
    expect(repo.refs.read("refs/remotes/origin/feature")).toBeNull();
    expect(repo.refs.read("refs/tags/v-main-only")).not.toBeNull();
    expect(repo.refs.read("refs/tags/v-feature")).toBeNull();
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
    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();
    expect(repo.refs.read("refs/tags/v-tag-only")).toBeNull();
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
    const tagHash = repo.refs.read("refs/tags/v-tag-only-fetch");
    expect(tagHash).not.toBeNull();
    expect(repo.refs.read("refs/remotes/origin/main")).toBeNull();
    expect(repo.objects.read(sha1(tagHash!)).type).toBe("tag");
  });

  test("非强制 fetch 更新已有 lightweight tag 应被拒绝（但 force 可以）", async () => {
    // 1. 在服务端创建 lightweight tag
    const initialCommit = git(["rev-parse", "HEAD"], workDir);
    git(["tag", "-f", "v-update", initialCommit], workDir);
    git(["push", serverRepoDir, "refs/tags/v-update"], workDir);

    // 2. 用 + 先在本地创建 lightweight tag
    const localDir = join(tempDir, "local-tag-update");
    const repo = initRepository(localDir);
    const firstResult = await repo.fetch(serverUrl, {
      refSpecs: ["+refs/tags/*:refs/tags/*"],
    });
    expect(firstResult.fetchedRefs.has("refs/tags/v-update")).toBe(true);

    // 3. 创建新的 commit 并推送到服务端
    createFile(workDir, "new-tag-file.txt", "new content\n");
    git(["add", "new-tag-file.txt"], workDir);
    git(["commit", "-m", "New commit for tag update"], workDir);
    git(["push", serverRepoDir, "main"], workDir);
    // 在服务端将 lightweight tag 移到新的 commit
    const newCommit = git(["rev-parse", "HEAD"], workDir);
    git(["--git-dir", serverRepoDir, "tag", "-f", "v-update", newCommit], tempDir);

    // 4. 非强制 fetch——应拒绝更新已有 tag
    const secondResult = await repo.fetch(serverUrl, {
      refSpecs: ["refs/tags/*:refs/tags/*"],
    });
    const localTagHash = repo.refs.read("refs/tags/v-update");
    expect(localTagHash).toBe(initialCommit);
    expect(secondResult.fetchedRefs.has("refs/tags/v-update")).toBe(false);

    // 5. 强制 fetch——应更新 tag
    const thirdResult = await repo.fetch(serverUrl, {
      refSpecs: ["+refs/tags/*:refs/tags/*"],
    });
    const updatedTagHash = repo.refs.read("refs/tags/v-update");
    expect(updatedTagHash).toBe(newCommit);
    expect(thirdResult.fetchedRefs.get("refs/tags/v-update")).toBe(sha1(newCommit));
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
    const mainRef = repo.refs.read("refs/remotes/origin/main");
    expect(mainRef).not.toBeNull();
    expect(repo.objects.read(sha1(mainRef!)).type).toBe("commit");
  });

  test("最小能力集：upload-pack advertisement 仅保留 ofs-delta 时 fetch 仍成功", async () => {
    const minimalServer = startGitHttpBackendServer(tempDir, "/server.git", undefined, {
      transformResponse(response: GitHttpBackendResponse, request: GitHttpRequestRecord) {
        if (
          request.method === "GET" &&
          request.path.endsWith("/info/refs") &&
          request.query === "service=git-upload-pack"
        ) {
          return rewriteAdvertisementCapabilities(response, () => ["ofs-delta"]);
        }
        return response;
      },
    });

    await using serverHandle = minimalServer;
    const localDir = join(tempDir, "local-minimal-upload-pack");
    const repo = initRepository(localDir);

    const result = await repo.fetch(serverHandle.url);

    expect(result.objectCount).toBeGreaterThan(0);
    const mainRef = repo.refs.read("refs/remotes/origin/main");
    expect(mainRef).not.toBeNull();
    expect(repo.objects.read(sha1(mainRef!)).type).toBe("commit");
  });
});
