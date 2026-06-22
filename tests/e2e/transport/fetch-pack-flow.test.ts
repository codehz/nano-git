/**
 * Fetch-pack 流程测试（传输层 E2E）
 *
 * 验证协议级交互：shallow fetch、能力降级、多轮协商等。
 *
 * 这些测试只关注对象同步和协议交互，不涉及 ref 映射或 remote 配置。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";

import { git, createTempDir, cleanupDir, createFile } from "../helpers.ts";
import {
  createServerRepo,
  decodeUploadPackCommands,
  countFlushPackets,
  getUploadPackRequests,
} from "./helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { sha1 } from "@/core/types.ts";
import { initRepository } from "@/repository/index.ts";
import { encodeFlushPkt, encodePktLine, parsePktLines } from "@/transport/pkt-line.ts";

import type { GitHttpBackendResponse, GitHttpRequestRecord } from "./http-server.ts";

// ============================================================================
// 广告改写辅助
// ============================================================================

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

// ============================================================================
// Shallow / 能力降级测试
// ============================================================================

describe("fetch-pack 流程", () => {
  let tempDir: string;
  let projectRoot: string;
  let _repoDir: string;
  let _workDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-fetch-pack");
    const remote = createServerRepo(tempDir, "remote.git");
    _repoDir = remote.repoDir;
    projectRoot = remote.projectRoot;
    _workDir = remote.workDir;
    server = startGitHttpBackendServer(projectRoot, "/remote.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("shallow fetch：depth=1 应成功完成初始拉取", async () => {
    const localDir = join(tempDir, "local-shallow");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    const result = await repo.fetchRemote("origin", { depth: 1 });

    expect(result.fetchedObjects).toBeGreaterThan(0);
    expect(repo.refs.read("refs/remotes/origin/main")).not.toBeNull();
  });

  test("协议降级：服务端不走 side-band-64k 时 fetch 仍成功", async () => {
    const downgradedServer = startGitHttpBackendServer(projectRoot, "/remote.git", undefined, {
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
    repo.addRemote({
      name: "downgraded",
      url: serverHandle.url,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    const result = await repo.fetchRemote("downgraded");

    expect(result.fetchedObjects).toBeGreaterThan(0);
    const mainRef = repo.refs.read("refs/remotes/origin/main");
    expect(mainRef).not.toBeNull();
    expect(repo.objects.read(sha1(mainRef!)).type).toBe("commit");
  });

  test("最小能力集：upload-pack advertisement 仅保留 ofs-delta 时 fetch 仍成功", async () => {
    const minimalServer = startGitHttpBackendServer(projectRoot, "/remote.git", undefined, {
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
    repo.addRemote({
      name: "minimal",
      url: serverHandle.url,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    const result = await repo.fetchRemote("minimal");

    expect(result.fetchedObjects).toBeGreaterThan(0);
    const mainRef = repo.refs.read("refs/remotes/origin/main");
    expect(mainRef).not.toBeNull();
    expect(repo.objects.read(sha1(mainRef!)).type).toBe("commit");
  });
});

// ============================================================================
// 协商测试
// ============================================================================

describe("fetch-pack 协商流程", () => {
  let tempDir: string;
  let repoDir: string;
  let projectRoot: string;
  let workDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-fetch-negotiate");
    const remote = createServerRepo(tempDir, "remote.git");
    repoDir = remote.repoDir;
    projectRoot = remote.projectRoot;
    workDir = remote.workDir;

    server = startGitHttpBackendServer(projectRoot, "/remote.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("增量 fetch：远端推进后发送 haves 并仅拉取新增对象", async () => {
    const localDir = join(tempDir, "local-incremental");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    const initialHead = git(["rev-parse", "HEAD"], workDir);
    const result1 = await repo.fetchRemote("origin");
    expect(result1.fetchedObjects).toBeGreaterThan(0);

    const firstUploadPackRequests = getUploadPackRequests(server.requests);
    expect(firstUploadPackRequests).toHaveLength(1);
    const firstCommands = decodeUploadPackCommands(firstUploadPackRequests[0]!.body);
    expect(firstCommands.some((line) => line.startsWith("have "))).toBe(false);

    server.clearRequests();

    createFile(workDir, "src/feature-a.ts", 'export const a = "a";\n');
    git(["add", "src/feature-a.ts"], workDir);
    git(["commit", "-m", "Add feature a"], workDir);

    createFile(workDir, "src/feature-b.ts", 'export const b = "b";\n');
    git(["add", "src/feature-b.ts"], workDir);
    git(["commit", "-m", "Add feature b"], workDir);

    const newHead = git(["rev-parse", "HEAD"], workDir);
    git(["push", repoDir, "main"], workDir);
    const expectedNewObjects = git(
      ["rev-list", "--objects", "--no-object-names", `${initialHead}..${newHead}`],
      workDir,
    )
      .split("\n")
      .filter((line) => line.length > 0).length;

    const result2 = await repo.fetchRemote("origin");

    expect(result2.fetchedObjects).toBeGreaterThan(0);
    expect(result2.fetchedObjects).toBe(expectedNewObjects);
    expect(result2.updatedRefs.get("refs/remotes/origin/main")).toBe(sha1(newHead));

    const secondUploadPackRequests = getUploadPackRequests(server.requests);
    expect(secondUploadPackRequests).toHaveLength(1);
    const secondCommands = decodeUploadPackCommands(secondUploadPackRequests[0]!.body);
    expect(secondCommands.some((line) => line === `have ${initialHead}`)).toBe(true);
    expect(secondCommands.some((line) => line.startsWith(`want ${newHead}`))).toBe(true);
  });

  test("增量 fetch：超过 32 个 haves 时使用多轮协商", async () => {
    const localDir = join(tempDir, "local-batched-haves");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    const totalInitialCommits = 36;
    for (let i = 0; i < totalInitialCommits; i++) {
      createFile(workDir, `history/commit-${i}.txt`, `commit-${i}\n`);
      git(["add", `history/commit-${i}.txt`], workDir);
      git(["commit", "-m", `History commit ${i}`], workDir);
    }
    git(["push", repoDir, "main"], workDir);

    const result1 = await repo.fetchRemote("origin");
    expect(result1.fetchedObjects).toBeGreaterThan(totalInitialCommits);

    server.clearRequests();

    createFile(workDir, "history/new-a.txt", "new-a\n");
    git(["add", "history/new-a.txt"], workDir);
    git(["commit", "-m", "New history a"], workDir);

    createFile(workDir, "history/new-b.txt", "new-b\n");
    git(["add", "history/new-b.txt"], workDir);
    git(["commit", "-m", "New history b"], workDir);

    const newHead = git(["rev-parse", "HEAD"], workDir);
    git(["push", repoDir, "main"], workDir);

    const result2 = await repo.fetchRemote("origin");

    expect(result2.fetchedObjects).toBeGreaterThan(0);
    expect(result2.fetchedObjects).toBeLessThan(result1.fetchedObjects);
    expect(result2.updatedRefs.get("refs/remotes/origin/main")).toBe(sha1(newHead));

    const uploadPackRequests = getUploadPackRequests(server.requests);
    expect(uploadPackRequests).toHaveLength(2);

    const secondBody = uploadPackRequests[0]!.body;
    const thirdBody = uploadPackRequests[1]!.body;
    const secondCommands = decodeUploadPackCommands(secondBody);
    const thirdCommands = decodeUploadPackCommands(thirdBody);
    const sentHaves = [...secondCommands, ...thirdCommands].filter((line) =>
      line.startsWith("have "),
    );

    expect(secondCommands.filter((line) => line.startsWith("have "))).toHaveLength(32);
    expect(countFlushPackets(secondBody)).toBe(2);
    expect(secondCommands.at(-1)).not.toBe("done");

    expect(thirdCommands.filter((line) => line.startsWith("have ")).length).toBeGreaterThan(0);
    expect(sentHaves.length).toBeGreaterThan(32);
    expect(new Set(sentHaves).size).toBe(37);
    expect(countFlushPackets(thirdBody)).toBe(1);
    expect(thirdCommands.at(-1)).toBe("done");

    const mainRef = repo.refs.read("refs/remotes/origin/main");
    expect(mainRef).toBe(newHead);
    expect(repo.objects.read(sha1(mainRef!)).type).toBe("commit");
  });

  test("增量 fetch：服务端返回 ACK continue 时后续轮次重放该 common", async () => {
    const localDir = join(tempDir, "local-ack-continue");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    const totalInitialCommits = 36;
    for (let i = 0; i < totalInitialCommits; i++) {
      createFile(workDir, `ack-continue-${i}.txt`, `ack-continue-${i}\n`);
      git(["add", `ack-continue-${i}.txt`], workDir);
      git(["commit", "-m", `ACK continue history commit ${i}`], workDir);
    }
    git(["push", repoDir, "main"], workDir);

    const firstFetch = await repo.fetchRemote("origin");
    expect(firstFetch.fetchedObjects).toBeGreaterThan(totalInitialCommits);

    await server.stop();

    let uploadPackPostCount = 0;
    let continuedHave: string | null = null;
    server = startGitHttpBackendServer(projectRoot, "/remote.git", undefined, {
      transformResponse(response, request): GitHttpBackendResponse {
        if (request.method !== "POST" || !request.path.endsWith("/git-upload-pack")) {
          return response;
        }

        uploadPackPostCount++;
        if (uploadPackPostCount !== 1) {
          return response;
        }

        const firstRoundCommands = decodeUploadPackCommands(request.body);
        const firstHave = firstRoundCommands.find((line) => line.startsWith("have "));
        if (!firstHave) {
          throw new Error("Expected first upload-pack round to contain at least one have command");
        }

        continuedHave = firstHave.slice("have ".length);
        return {
          ...response,
          body: Buffer.concat([
            encodePktLine(`ACK ${continuedHave} continue\n`),
            encodePktLine("NAK\n"),
          ]),
        };
      },
    });

    serverUrl = server.url;
    repo.addRemote({
      name: "origin-ack",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    createFile(workDir, "ack-continue-new-a.txt", "ack-continue-new-a\n");
    git(["add", "ack-continue-new-a.txt"], workDir);
    git(["commit", "-m", "ACK continue new a"], workDir);

    createFile(workDir, "ack-continue-new-b.txt", "ack-continue-new-b\n");
    git(["add", "ack-continue-new-b.txt"], workDir);
    git(["commit", "-m", "ACK continue new b"], workDir);

    const newHead = git(["rev-parse", "HEAD"], workDir);
    git(["push", repoDir, "main"], workDir);

    const secondFetch = await repo.fetchRemote("origin-ack");
    expect(secondFetch.fetchedObjects).toBeGreaterThan(0);
    expect(secondFetch.updatedRefs.get("refs/remotes/origin/main")).toBe(sha1(newHead));

    const uploadPackRequests = getUploadPackRequests(server.requests);
    expect(uploadPackRequests).toHaveLength(2);
    expect(continuedHave).not.toBeNull();

    const secondRoundCommands = decodeUploadPackCommands(uploadPackRequests[1]!.body);
    expect(secondRoundCommands).toContain(`have ${continuedHave}`);
    expect(secondRoundCommands.at(-1)).toBe("done");
  });

  // ============================================================================
  // 协商优化测试（起点裁剪、maxCandidates）
  // ============================================================================

  test("起点裁剪：本地 tag 不添加额外 have 候选，fetch 正常执行", async () => {
    const localDir = join(tempDir, "local-tag-nonpollute");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    // 1. 初始 fetch
    const result1 = await repo.fetchRemote("origin");
    expect(result1.fetchedObjects).toBeGreaterThan(0);

    // 2. 在本地仓库创建与 fetch 无关的 tag（pointer to old commit）
    const mainHash = repo.refs.read("refs/remotes/origin/main")!;
    // 使用 git 创建 lightweight tag（不会干扰 nano-git 的操作）
    git(["tag", "e2e-old-tag", mainHash], localDir);

    // 3. 服务端推一个新提交
    createFile(workDir, `tag-pollution-${Date.now()}.txt`, "tag-content\n");
    git(["add", "."], workDir);
    git(["commit", "-m", "commit after tag"], workDir);
    const newHead = git(["rev-parse", "HEAD"], workDir);
    git(["push", repoDir, "main"], workDir);

    server.clearRequests();

    // 4. 增量 fetch，验证仍能正常拉取
    const result2 = await repo.fetchRemote("origin");
    expect(result2.fetchedObjects).toBeGreaterThan(0);
    expect(result2.updatedRefs.get("refs/remotes/origin/main")).toBe(sha1(newHead));

    // 5. 验证请求中 have 不超过候选集上限
    const requests = getUploadPackRequests(server.requests);
    expect(requests.length).toBeGreaterThan(0);
    const commands = decodeUploadPackCommands(requests[0]!.body);
    const haves = commands.filter((c) => c.startsWith("have "));
    // tag 没有污染 have 列表（tag 指向的 commit 可能仍因是祖先而出现，
    // 但 tag 本身不作为额外 tip 加入）
    expect(haves.length).toBeLessThanOrEqual(20);
  });

  test("起点裁剪：feature 分支的 remote-tracking ref 能帮助 main 避免重传", async () => {
    const localDir = join(tempDir, "local-cross-ref");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    // 1. 初始 fetch
    const result1 = await repo.fetchRemote("origin");
    expect(result1.fetchedObjects).toBeGreaterThan(0);

    // 2. 创建 feature 分支并推送
    const featDir = join(tempDir, "work-feat-ref");
    git(["clone", repoDir, featDir], tempDir);
    createFile(featDir, "feature-cross.txt", "feature-cross\n");
    git(["add", "feature-cross.txt"], featDir);
    git(["commit", "-m", "Feature cross"], featDir);
    const featureHash = git(["rev-parse", "HEAD"], featDir);
    git(["push", repoDir, `HEAD:feature`], featDir);

    // 3. fetch feature 到本地
    server.clearRequests();
    const result2 = await repo.fetchRemote("origin");
    expect(result2.updatedRefs.has("refs/remotes/origin/feature")).toBe(true);

    // 4. 服务端将 main 快进到 feature commit
    git(["update-ref", "refs/heads/main", featureHash], repoDir);
    server.clearRequests();

    // 5. 再次 fetch main：feature commit 已通过之前的 fetch 在本地
    const result3 = await repo.fetchRemote("origin");
    // selectHaveTips 会使用 refs/remotes/origin/feature 作为 tip，
    // collectHaveCommits 能遍历到 feature commit，服务端不再重复发送
    expect(result3.fetchedObjects).toBe(0);
    expect(result3.updatedRefs.get("refs/remotes/origin/main")).toBe(sha1(featureHash));
  });

  test("maxCandidates 限制下增量 fetch 仍能正常完成", async () => {
    const localDir = join(tempDir, "local-max-candidates");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    // 1. 在服务端创建 30 个提交（maxCandidates 设为 10）
    for (let i = 0; i < 30; i++) {
      createFile(workDir, `max-cand-${i}.txt`, `cand-${i}\n`);
      git(["add", `max-cand-${i}.txt`], workDir);
      git(["commit", "-m", `MaxCandidates commit ${i}`], workDir);
    }
    git(["push", repoDir, "main"], workDir);

    // 2. 初始 fetch，设 maxCandidates=10
    const result1 = await repo.fetchRemote("origin", { maxCandidates: 10 });
    expect(result1.fetchedObjects).toBeGreaterThan(0);
    expect(repo.refs.read("refs/remotes/origin/main")).not.toBeNull();

    // 3. 新增 2 个提交
    createFile(workDir, "max-cand-new-a.txt", "new-a\n");
    git(["add", "max-cand-new-a.txt"], workDir);
    git(["commit", "-m", "MaxCandidates new a"], workDir);
    createFile(workDir, "max-cand-new-b.txt", "new-b\n");
    git(["add", "max-cand-new-b.txt"], workDir);
    git(["commit", "-m", "MaxCandidates new b"], workDir);
    const newHead = git(["rev-parse", "HEAD"], workDir);
    git(["push", repoDir, "main"], workDir);

    server.clearRequests();

    // 4. 增量 fetch，maxCandidates=10
    const result2 = await repo.fetchRemote("origin", { maxCandidates: 10 });
    expect(result2.fetchedObjects).toBeGreaterThan(0);
    expect(result2.updatedRefs.get("refs/remotes/origin/main")).toBe(sha1(newHead));

    // 5. 验证请求体中的 have 确实被 maxCandidates 截断
    const requests = getUploadPackRequests(server.requests);
    expect(requests.length).toBeGreaterThanOrEqual(1);
    const commandsPerRound = requests.map((r) => decodeUploadPackCommands(r.body));
    const totalHaves = commandsPerRound.flat().filter((c) => c.startsWith("have "));
    // 总 haves 应受 maxCandidates(10) 限制，不超过 10
    expect(totalHaves.length).toBeLessThanOrEqual(10);
  });

  test("多次增量 fetch：连续多次 fetch 后仓库一致性不受影响", async () => {
    const localDir = join(tempDir, "local-multi-fetch-consistent");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    // 连续 5 次小步 fetch
    for (let round = 1; round <= 5; round++) {
      createFile(workDir, `multi-round-${round}.txt`, `round-${round}\n`);
      git(["add", `multi-round-${round}.txt`], workDir);
      git(["commit", "-m", `Multi round ${round}`], workDir);
      git(["push", repoDir, "main"], workDir);

      const result = await repo.fetchRemote("origin");
      expect(result.fetchedObjects).toBeGreaterThanOrEqual(0);
      expect(result.updatedRefs.size).toBeGreaterThan(0);
    }

    // 最终仓库完整性检查
    const finalMain = repo.refs.read("refs/remotes/origin/main");
    expect(finalMain).toBe(git(["rev-parse", "HEAD"], workDir));

    // 用 git fsck 验证对象完整性
    const fsckOut = git(["fsck", "--no-dangling"], localDir);
    expect(fsckOut).not.toContain("error");
    expect(fsckOut).not.toContain("broken");
  });

  test("多轮协商：超过 32 haves + maxCandidates 双重限制下正确完成", async () => {
    const localDir = join(tempDir, "local-dual-limits");
    const repo = initRepository(localDir);
    repo.addRemote({
      name: "origin",
      url: serverUrl,
      fetchRules: [{ source: "+refs/heads/*", target: "refs/remotes/origin/*" }],
    });

    // 1. 服务端创建 50 个提交
    for (let i = 0; i < 50; i++) {
      createFile(workDir, `dual-${i}.txt`, `dual-${i}\n`);
      git(["add", `dual-${i}.txt`], workDir);
      git(["commit", "-m", `Dual commit ${i}`], workDir);
    }
    git(["push", repoDir, "main"], workDir);

    // 2. 初始 fetch，maxCandidates=30（受预算限制，只取 30 个候选）
    const result1 = await repo.fetchRemote("origin", { maxCandidates: 30 });
    expect(result1.fetchedObjects).toBeGreaterThan(0);

    // 3. 服务端新增 2 个提交
    createFile(workDir, "dual-new-a.txt", "dual-new-a\n");
    git(["add", "dual-new-a.txt"], workDir);
    git(["commit", "-m", "Dual new a"], workDir);
    createFile(workDir, "dual-new-b.txt", "dual-new-b\n");
    git(["add", "dual-new-b.txt"], workDir);
    git(["commit", "-m", "Dual new b"], workDir);
    const newHead = git(["rev-parse", "HEAD"], workDir);
    git(["push", repoDir, "main"], workDir);

    server.clearRequests();

    // 4. 增量 fetch，maxCandidates=30（但本地只有 30 个候选，≤32，单轮即可）
    const result2 = await repo.fetchRemote("origin", { maxCandidates: 30 });
    expect(result2.fetchedObjects).toBeGreaterThan(0);
    expect(result2.updatedRefs.get("refs/remotes/origin/main")).toBe(sha1(newHead));

    const requests = getUploadPackRequests(server.requests);
    // 因为候选只有 30，不超过 MAX_HAVES_PER_ROUND(32)，单轮即可
    expect(requests).toHaveLength(1);

    const commands = decodeUploadPackCommands(requests[0]!.body);
    const haves = commands.filter((c) => c.startsWith("have "));
    // 候选被 maxCandidates 限制在 30 个以内
    expect(haves.length).toBeLessThanOrEqual(30);
  });
});
