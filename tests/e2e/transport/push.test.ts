/**
 * Push 高层 API 端到端测试
 *
 * 通过 HTTP 服务将 push() 的全套编排逻辑接入 git http-backend：
 *   parseRefSpec → determinePushRefs → checkFastForward → collectReachable
 *   → createPackWriter → buildReceivePackRequest → transport.request → decodeReceivePackResponse
 *
 * 不依赖手工构造协议报文，完整验证高层 push() 函数的网络路径行为。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { git, gitInit, createTempDir, cleanupDir, createFile, FIXED_AUTHOR } from "../helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { sha1 } from "@/core/types.ts";
import { HEAD_REF, HEADS_PREFIX } from "@/refs/index.ts";
import { createMemoryRepository } from "@/repository/index.ts";
import { encodeFlushPkt, encodePktLine, parsePktLines } from "@/transport/pkt-line.ts";

import type { GitHttpBackendResponse } from "./http-server.ts";

// ============================================================================
// 辅助函数
// ============================================================================

function enableReceivePack(repoDir: string): void {
  const configPath = join(repoDir, "config");
  const config = readFileSync(configPath, "utf-8");
  if (!config.includes("http.receivepack")) {
    writeFileSync(configPath, config + "\n[http]\n\treceivepack = true\n");
  }
}

function encodeSideBandFrame(channel: 1 | 2 | 3, payload: Buffer | string): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
  return encodePktLine(Buffer.concat([Buffer.from([channel]), data]));
}

function rewriteReceivePackResponseAsSplitSideBand(
  response: GitHttpBackendResponse,
): GitHttpBackendResponse {
  const outerLines = parsePktLines(response.body);
  const channel1Chunks: Buffer[] = [];
  const progressChunks: Buffer[] = [];

  for (const line of outerLines) {
    if (line.type !== "data" || line.payload.length === 0) {
      continue;
    }
    const channel = line.payload[0];
    const frameData = line.payload.subarray(1);
    if (channel === 0x01) {
      channel1Chunks.push(frameData);
    } else if (channel === 0x02) {
      progressChunks.push(frameData);
    }
  }

  const reportStatus = Buffer.concat(channel1Chunks);
  if (reportStatus.length < 2) {
    return response;
  }

  const splitAt = Math.max(1, Math.floor(reportStatus.length / 2));
  const rewrittenBody = Buffer.concat([
    ...progressChunks.map((chunk) => encodeSideBandFrame(2, chunk)),
    encodeSideBandFrame(2, "remote: side-band progress\n"),
    encodeSideBandFrame(1, reportStatus.subarray(0, splitAt)),
    encodeSideBandFrame(1, reportStatus.subarray(splitAt)),
    encodeFlushPkt(),
  ]);

  return {
    ...response,
    body: rewrittenBody,
    headers: {
      ...response.headers,
      "Content-Type": "application/x-git-receive-pack-result",
    },
  };
}

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

function rewriteReceivePackResponseAsPlainReportStatus(
  response: GitHttpBackendResponse,
): GitHttpBackendResponse {
  const outerLines = parsePktLines(response.body);
  const channel1Chunks: Buffer[] = [];

  for (const line of outerLines) {
    if (line.type !== "data" || line.payload.length === 0) {
      continue;
    }
    if (line.payload[0] === 0x01) {
      channel1Chunks.push(line.payload.subarray(1));
    }
  }

  const reportStatus = Buffer.concat(channel1Chunks);
  if (reportStatus.length === 0) {
    return response;
  }

  return {
    ...response,
    body: reportStatus,
    headers: {
      ...response.headers,
      "Content-Type": "application/x-git-receive-pack-result",
    },
  };
}

// ============================================================================
// 测试
// ============================================================================

describe("push() 端到端", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-push-cgi");

    // 1. 创建服务端裸仓库
    serverRepoDir = join(tempDir, "server.git");
    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);
    enableReceivePack(serverRepoDir);

    // 2. 创建初始提交并推送到服务端作为基准
    workDir = join(tempDir, "work");
    gitInit(workDir);
    createFile(workDir, "README.md", "# Hello\n");
    git(["add", "README.md"], workDir);
    git(["commit", "-m", "Initial commit"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    // 3. 启动 HTTP 服务
    server = startGitHttpBackendServer(tempDir, "/server.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("推送新分支到远端", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const fileHash = repo.writeBlob(Buffer.from("new branch content"));
    const treeHash = repo.createTree([{ mode: "100644", name: "new-branch.txt", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "New branch commit", author);
    repo.updateRef("refs/heads/new-feature", commitHash);

    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/new-feature:refs/heads/new-feature"],
    });

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.pushedRefs[0]!.refName).toBe("refs/heads/new-feature");

    const serverRef = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/heads/new-feature"],
      tempDir,
    );
    expect(serverRef).toBe(commitHash);
  });

  test("首次 push 到空远端仓库", async () => {
    const emptyRepoDir = join(tempDir, "empty-push.git");
    mkdirSync(emptyRepoDir);
    git(["init", "--bare"], emptyRepoDir);
    enableReceivePack(emptyRepoDir);

    await using emptyServer = startGitHttpBackendServer(tempDir, "/empty-push.git");

    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const fileHash = repo.writeBlob(Buffer.from("initial empty remote push"));
    const treeHash = repo.createTree([{ mode: "100644", name: "README.md", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Initial push to empty remote", author);
    repo.updateRef("refs/heads/main", commitHash);

    const result = await repo.push(emptyServer.url, {
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.pushedRefs[0]!.refName).toBe("refs/heads/main");

    const remoteMain = git(["--git-dir", emptyRepoDir, "rev-parse", "refs/heads/main"], tempDir);
    expect(remoteMain).toBe(commitHash);
  });

  test("通过 push 删除远程分支", async () => {
    // 1. 先用系统 git 创建 feature 分支并推送到服务端
    createFile(workDir, "FEATURE.md", "# Feature\n");
    git(["add", "FEATURE.md"], workDir);
    git(["commit", "-m", "Feature commit"], workDir);
    const branchHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "HEAD:refs/heads/feature"], workDir);

    const branchRef = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/feature"], tempDir);
    expect(branchRef).toBe(branchHash);

    // 2. 用 nano-git push 删除远程分支
    const deleteRepo = createMemoryRepository();
    const deleteResult = await deleteRepo.push(serverUrl, {
      refSpecs: [":refs/heads/feature"],
    });

    expect(deleteResult.pushedRefs).toHaveLength(1);
    expect(deleteResult.pushedRefs[0]!.success).toBe(true);
    expect(deleteResult.pushedRefs[0]!.refName).toBe("refs/heads/feature");

    const branchList = git(["--git-dir", serverRepoDir, "branch", "-a"], tempDir);
    expect(branchList).not.toContain("feature");
  });

  test("删除不存在的远程分支：服务端警告但整体成功", async () => {
    const repo = createMemoryRepository();

    const result = await repo.push(serverUrl, {
      refSpecs: [":refs/heads/nonexistent"],
    });

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.pushedRefs[0]!.refName).toBe("refs/heads/nonexistent");
    expect(result.objectCount).toBe(0);
  });

  test("协议降级：receive-pack 返回纯 report-status 时仍能正确解析 push 结果", async () => {
    await using downgradedServer = startGitHttpBackendServer(tempDir, "/server.git", undefined, {
      transformResponse(response, request) {
        if (
          request.method === "GET" &&
          request.path.endsWith("/info/refs") &&
          request.query === "service=git-receive-pack"
        ) {
          return stripCapabilityFromAdvertisement(response, "side-band-64k");
        }
        if (request.method === "POST" && request.path.endsWith("/git-receive-pack")) {
          return rewriteReceivePackResponseAsPlainReportStatus(response);
        }
        return response;
      },
    });

    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const fileHash = repo.writeBlob(Buffer.from("plain report-status"));
    const treeHash = repo.createTree([{ mode: "100644", name: "plain.txt", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Plain report-status", author);
    repo.updateRef("refs/heads/plain-status", commitHash);

    const result = await repo.push(downgradedServer.url, {
      refSpecs: ["refs/heads/plain-status:refs/heads/plain-status"],
    });

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.progress).toEqual([]);

    const remoteRef = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/heads/plain-status"],
      tempDir,
    );
    expect(remoteRef).toBe(commitHash);
  });

  test("最小能力集：receive-pack advertisement 仅保留 report-status 时 push 仍成功", async () => {
    await using minimalServer = startGitHttpBackendServer(tempDir, "/server.git", undefined, {
      transformResponse(response, request) {
        if (
          request.method === "GET" &&
          request.path.endsWith("/info/refs") &&
          request.query === "service=git-receive-pack"
        ) {
          return rewriteAdvertisementCapabilities(response, () => ["report-status"]);
        }
        if (request.method === "POST" && request.path.endsWith("/git-receive-pack")) {
          return rewriteReceivePackResponseAsPlainReportStatus(response);
        }
        return response;
      },
    });

    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const fileHash = repo.writeBlob(Buffer.from("minimal receive-pack caps"));
    const treeHash = repo.createTree([{ mode: "100644", name: "minimal.txt", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Minimal receive-pack caps", author);
    repo.updateRef("refs/heads/minimal-status", commitHash);

    const result = await repo.push(minimalServer.url, {
      refSpecs: ["refs/heads/minimal-status:refs/heads/minimal-status"],
    });

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.progress).toEqual([]);

    const remoteRef = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/heads/minimal-status"],
      tempDir,
    );
    expect(remoteRef).toBe(commitHash);
  });

  test("non-fast-forward 推送到远端被本地预检拒绝", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 获取服务端 refs/heads/main 的哈希，用于制造分叉
    // 注意：这个哈希在本地 store 中不存在，但 checkFastForward 中 isAncestor 使用的是本地 store
    // 所以这里我们只需确保 remoteHash 不等于 localHash 且没有祖先关系即可
    const _remoteMainHash = sha1(
      git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/main"], tempDir),
    );

    // 本地创建分叉 commit
    const fileHash = repo.writeBlob(Buffer.from("divergent"));
    const treeHash = repo.createTree([{ mode: "100644", name: "d.txt", hash: fileHash }]);
    const divergentHash = repo.createCommit(treeHash, [], "Divergent", author);
    repo.updateRef("refs/heads/main", divergentHash);

    const pushPromise = repo.push(serverUrl, {
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });

    expect(pushPromise).rejects.toThrow("Non-fast-forward");
  });

  test("non-fast-forward 但设 force 时可以通过", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const fileHash = repo.writeBlob(Buffer.from("forced"));
    const treeHash = repo.createTree([{ mode: "100644", name: "f.txt", hash: fileHash }]);
    const forceHash = repo.createCommit(treeHash, [], "Forced", author);
    repo.updateRef("refs/heads/main", forceHash);

    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/main:refs/heads/main"],
      force: true,
    });

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.pushedRefs[0]!.refName).toBe("refs/heads/main");

    const serverRef = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/main"], tempDir);
    expect(serverRef).toBe(forceHash);
  });

  test("通过 push 推送 tag 到远端", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const fileHash = repo.writeBlob(Buffer.from("tagged content"));
    const treeHash = repo.createTree([{ mode: "100644", name: "tagged.txt", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Tagged commit", author);
    repo.updateRef("refs/tags/v1", commitHash);

    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/tags/v1:refs/tags/v1"],
    });

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.pushedRefs[0]!.refName).toBe("refs/tags/v1");

    const serverRef = git(["--git-dir", serverRepoDir, "rev-parse", "refs/tags/v1"], tempDir);
    expect(serverRef).toBe(commitHash);
  });

  test("推送多个分支到远端", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 创建第一个分支的 commit
    const hashA = repo.writeBlob(Buffer.from("multi branch a"));
    const treeA = repo.createTree([{ mode: "100644", name: "a.txt", hash: hashA }]);
    const commitA = repo.createCommit(treeA, [], "Feature A", author);
    repo.updateRef("refs/heads/feature-a", commitA);

    // 创建第二个分支的 commit
    const hashB = repo.writeBlob(Buffer.from("multi branch b"));
    const treeB = repo.createTree([{ mode: "100644", name: "b.txt", hash: hashB }]);
    const commitB = repo.createCommit(treeB, [], "Feature B", author);
    repo.updateRef("refs/heads/feature-b", commitB);

    // 一次 push 两个 refspec
    const result = await repo.push(serverUrl, {
      refSpecs: [
        "refs/heads/feature-a:refs/heads/feature-a",
        "refs/heads/feature-b:refs/heads/feature-b",
      ],
    });

    expect(result.pushedRefs).toHaveLength(2);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.pushedRefs[1]!.success).toBe(true);
    expect(result.objectCount).toBeGreaterThan(0);

    const serverA = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/feature-a"], tempDir);
    expect(serverA).toBe(commitA);
    const serverB = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/feature-b"], tempDir);
    expect(serverB).toBe(commitB);
  });

  test("通过 push 推送注解 tag（annotated tag）到远端", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 先创建一个 commit 用于 tag 指向
    const blobHash = repo.writeBlob(Buffer.from("annotated tag content"));
    const treeHash = repo.createTree([{ mode: "100644", name: "annotated.txt", hash: blobHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Commit for annotated tag", author);
    repo.updateRef("refs/heads/main", commitHash);

    // 创建注解 tag
    const tagHash = repo.createAnnotatedTag("v1.0", commitHash, "Release v1.0", author);

    // push 注解 tag
    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/tags/v1.0:refs/tags/v1.0"],
    });

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.pushedRefs[0]!.refName).toBe("refs/tags/v1.0");

    // 验证服务端 tag 对象存在且指向正确
    const serverTagHash = git(["--git-dir", serverRepoDir, "rev-parse", "refs/tags/v1.0"], tempDir);
    expect(serverTagHash).toBe(tagHash);

    const serverTagType = git(["--git-dir", serverRepoDir, "cat-file", "-t", tagHash], tempDir);
    expect(serverTagType).toBe("tag");

    const serverTaggedObject = git(
      ["--git-dir", serverRepoDir, "cat-file", "-p", tagHash],
      tempDir,
    );
    expect(serverTaggedObject).toContain(`object ${commitHash}`);
    expect(serverTaggedObject).toContain("tag v1.0");
  });

  test("自定义 ref 指向 non-commit 对象时：non-force 拒绝，force 允许", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const blobHash = repo.writeBlob(Buffer.from("blob payload for custom ref"));
    const firstTagHash = repo.createAnnotatedTag(
      "blobtag-v1",
      blobHash,
      "Blob tag v1",
      author,
      "blob",
    );

    const firstResult = await repo.push(serverUrl, {
      refSpecs: ["refs/tags/blobtag-v1:refs/custom/blob-target"],
    });
    expect(firstResult.pushedRefs).toHaveLength(1);
    expect(firstResult.pushedRefs[0]!.success).toBe(true);

    const remoteAfterFirstPush = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/custom/blob-target"],
      tempDir,
    );
    expect(remoteAfterFirstPush).toBe(firstTagHash);
    expect(git(["--git-dir", serverRepoDir, "cat-file", "-t", firstTagHash], tempDir)).toBe("tag");

    const secondTagHash = repo.createAnnotatedTag(
      "blobtag-v2",
      blobHash,
      "Blob tag v2",
      { ...author, timestamp: author.timestamp + 60 },
      "blob",
    );

    const rejectedPush = repo.push(serverUrl, {
      refSpecs: ["refs/tags/blobtag-v2:refs/custom/blob-target"],
    });
    expect(rejectedPush).rejects.toThrow(/Use force|expected commit|non-commit/i);

    const remoteAfterReject = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/custom/blob-target"],
      tempDir,
    );
    expect(remoteAfterReject).toBe(firstTagHash);

    const forcedResult = await repo.push(serverUrl, {
      refSpecs: ["+refs/tags/blobtag-v2:refs/custom/blob-target"],
    });
    expect(forcedResult.pushedRefs).toHaveLength(1);
    expect(forcedResult.pushedRefs[0]!.success).toBe(true);
    expect(forcedResult.pushedRefs[0]!.forced).toBe(true);

    const remoteAfterForce = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/custom/blob-target"],
      tempDir,
    );
    expect(remoteAfterForce).toBe(secondTagHash);
  });

  test("通过 push 删除远程 tag", async () => {
    // 1. 先用系统 git 创建 tag 并推送到服务端
    createFile(workDir, "to-delete.txt", "will be deleted\n");
    git(["add", "to-delete.txt"], workDir);
    git(["commit", "-m", "Add file for tag"], workDir);
    const tagHash = git(["rev-parse", "HEAD"], workDir);
    git(["tag", "v-delete"], workDir);
    git(["push", serverRepoDir, "refs/tags/v-delete"], workDir);

    const serverTagRef = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/tags/v-delete"],
      tempDir,
    );
    expect(serverTagRef).toBe(tagHash);

    // 2. 用 nano-git push 删除远程 tag
    const deleteRepo = createMemoryRepository();
    const deleteResult = await deleteRepo.push(serverUrl, {
      refSpecs: [":refs/tags/v-delete"],
    });

    expect(deleteResult.pushedRefs).toHaveLength(1);
    expect(deleteResult.pushedRefs[0]!.success).toBe(true);
    expect(deleteResult.pushedRefs[0]!.refName).toBe("refs/tags/v-delete");

    // 验证服务端 tag 已被删除
    const tagList = git(["--git-dir", serverRepoDir, "tag", "-l"], tempDir);
    expect(tagList).not.toContain("v-delete");
  });

  test("推送自定义目标分支名（本地 main → 远程 custom-branch）", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const blobHash = repo.writeBlob(Buffer.from("custom branch target"));
    const treeHash = repo.createTree([{ mode: "100644", name: "custom.txt", hash: blobHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Custom branch commit", author);
    repo.updateRef("refs/heads/main", commitHash);

    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/main:refs/heads/custom-branch"],
    });

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.pushedRefs[0]!.refName).toBe("refs/heads/custom-branch");

    const serverRef = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/heads/custom-branch"],
      tempDir,
    );
    expect(serverRef).toBe(commitHash);
  });

  test("everything-up-to-date：推送已存在的引用时仍返回成功", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 1. 第一次推送：建立远程分支
    const blobHash = repo.writeBlob(Buffer.from("up to date content"));
    const treeHash = repo.createTree([{ mode: "100644", name: "uptodate.txt", hash: blobHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Uptodate commit", author);
    repo.updateRef("refs/heads/uptodate", commitHash);

    const firstResult = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/uptodate:refs/heads/uptodate"],
    });
    expect(firstResult.pushedRefs).toHaveLength(1);
    expect(firstResult.pushedRefs[0]!.success).toBe(true);

    // 2. 第二次推送完全相同的内容
    const secondResult = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/uptodate:refs/heads/uptodate"],
    });
    expect(secondResult.pushedRefs).toHaveLength(1);
    expect(secondResult.pushedRefs[0]!.success).toBe(true);
    expect(secondResult.pushedRefs[0]!.refName).toBe("refs/heads/uptodate");
    // 没有新对象需要发送
    expect(secondResult.objectCount).toBe(0);
  });

  test("everything-up-to-date：已有 lightweight tag 同哈希重推仍返回成功", async () => {
    // 验证 refs/tags/* 的 no-op 推送不应被误判为非法替换
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const fileHash = repo.writeBlob(Buffer.from("tag up to date"));
    const treeHash = repo.createTree([{ mode: "100644", name: "tagged.txt", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Tag commit", author);
    repo.updateRef("refs/tags/v-up2date", commitHash);

    // 1. 第一次推送：创建远程 tag
    const firstResult = await repo.push(serverUrl, {
      refSpecs: ["refs/tags/v-up2date:refs/tags/v-up2date"],
    });
    expect(firstResult.pushedRefs).toHaveLength(1);
    expect(firstResult.pushedRefs[0]!.success).toBe(true);

    // 2. 第二次推送完全相同的内容（no-op）
    const secondResult = await repo.push(serverUrl, {
      refSpecs: ["refs/tags/v-up2date:refs/tags/v-up2date"],
    });
    expect(secondResult.pushedRefs).toHaveLength(1);
    expect(secondResult.pushedRefs[0]!.success).toBe(true);
    expect(secondResult.pushedRefs[0]!.refName).toBe("refs/tags/v-up2date");
    expect(secondResult.objectCount).toBe(0);
  });

  test("多次推送累积 commit", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 1. 推送第一个 commit
    const blob1 = repo.writeBlob(Buffer.from("commit 1"));
    const tree1 = repo.createTree([{ mode: "100644", name: "f1.txt", hash: blob1 }]);
    const commit1 = repo.createCommit(tree1, [], "First commit", author);
    repo.updateRef("refs/heads/incremental", commit1);

    const result1 = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/incremental:refs/heads/incremental"],
    });
    expect(result1.pushedRefs[0]!.success).toBe(true);

    // 2. 在第一个 commit 之上再推送第二个 commit
    const blob2 = repo.writeBlob(Buffer.from("commit 2"));
    const tree2 = repo.createTree([
      { mode: "100644", name: "f1.txt", hash: blob1 },
      { mode: "100644", name: "f2.txt", hash: blob2 },
    ]);
    const commit2 = repo.createCommit(tree2, [commit1], "Second commit", author);
    repo.updateRef("refs/heads/incremental", commit2);

    const result2 = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/incremental:refs/heads/incremental"],
    });
    expect(result2.pushedRefs[0]!.success).toBe(true);
    expect(result2.objectCount).toBeGreaterThan(0);

    // 3. 再推送第三个 commit
    const blob3 = repo.writeBlob(Buffer.from("commit 3"));
    const tree3 = repo.createTree([
      { mode: "100644", name: "f1.txt", hash: blob1 },
      { mode: "100644", name: "f2.txt", hash: blob2 },
      { mode: "100644", name: "f3.txt", hash: blob3 },
    ]);
    const commit3 = repo.createCommit(tree3, [commit2], "Third commit", author);
    repo.updateRef("refs/heads/incremental", commit3);

    const result3 = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/incremental:refs/heads/incremental"],
    });
    expect(result3.pushedRefs[0]!.success).toBe(true);

    // 验证服务端最终状态
    const serverRef = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/heads/incremental"],
      tempDir,
    );
    expect(serverRef).toBe(commit3);

    const serverLog = git(
      ["--git-dir", serverRepoDir, "log", "--oneline", "refs/heads/incremental"],
      tempDir,
    );
    expect(serverLog.split("\n")).toHaveLength(3);
  });

  test("通配符 refspec 推送所有分支（refs/heads/*:refs/heads/*）", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 创建两个分支
    const hashA = repo.writeBlob(Buffer.from("wildcard a"));
    const treeA = repo.createTree([{ mode: "100644", name: "wa.txt", hash: hashA }]);
    const commitA = repo.createCommit(treeA, [], "Wildcard A", author);
    repo.updateRef("refs/heads/branch-wa", commitA);

    const hashB = repo.writeBlob(Buffer.from("wildcard b"));
    const treeB = repo.createTree([{ mode: "100644", name: "wb.txt", hash: hashB }]);
    const commitB = repo.createCommit(treeB, [], "Wildcard B", author);
    repo.updateRef("refs/heads/branch-wb", commitB);

    // 使用通配符 refspec 推送
    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/*:refs/heads/*"],
    });

    expect(result.pushedRefs).toHaveLength(2);
    expect(result.pushedRefs.every((u) => u.success)).toBe(true);

    const serverA = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/branch-wa"], tempDir);
    expect(serverA).toBe(commitA);
    const serverB = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/branch-wb"], tempDir);
    expect(serverB).toBe(commitB);
  });

  test("推送引用时本地 ref 不存在则抛出异常", async () => {
    const repo = createMemoryRepository();

    const pushPromise = repo.push(serverUrl, {
      refSpecs: ["refs/heads/non-existent:refs/heads/non-existent"],
    });

    expect(pushPromise).rejects.toThrow("Local ref not found");
  });

  test("tree 引用缺失 blob 时在客户端失败，不向 git-http-backend 发送不完整 pack", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const hashA = repo.writeBlob(Buffer.from("present blob"));
    const missingBlob = repo.hashObject(Buffer.from("missing blob"));
    const treeHash = repo.createTree([
      { mode: "100644", name: "ok.txt", hash: hashA },
      { mode: "100644", name: "missing.txt", hash: missingBlob },
    ]);
    const commitHash = repo.createCommit(treeHash, [], "Corrupt tree commit", author);
    repo.updateRef("refs/heads/corrupt-tree", commitHash);

    const pushPromise = repo.push(serverUrl, {
      refSpecs: ["refs/heads/corrupt-tree:refs/heads/corrupt-tree"],
    });

    expect(pushPromise).rejects.toThrow(/missing from the local store/i);

    const branchList = git(["--git-dir", serverRepoDir, "branch", "-a"], tempDir);
    expect(branchList).not.toContain("corrupt-tree");
  });

  test("默认 refspec 推送当前分支（非 main）到同名远端分支", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 先导入远端对象，使本地 store 拥有服务端提交（避免 push 时 parent commit 缺失）
    const importSession = await repo.openImportSession({ url: serverUrl });
    await importSession
      .plan()
      .materialize(importSession.allRefs())
      .toNamespace("refs/mirrors/upstream/*", { policy: { mode: "mirror" }, prune: true })
      .apply();

    // 清理可能残留的 server feature ref，保证测试隔离
    try {
      git(["update-ref", "-d", "refs/heads/feature"], serverRepoDir);
    } catch {}

    // 将 HEAD 指向 feature 分支
    repo.refs.write(HEAD_REF, `ref: ${HEADS_PREFIX}feature`);

    // 获取本地已有的 main 作为 base（fetch 后存在）
    const mirroredMain = repo.refs.read("refs/mirrors/upstream/main");
    if (!mirroredMain) throw new Error("mirrored main missing after import");
    const baseCommit = sha1(mirroredMain);

    // 在 feature 分支上创建 commit（基于已 fetch 的对象）
    const fileHash = repo.writeBlob(Buffer.from("feature branch content"));
    const treeHash = repo.createTree([{ mode: "100644", name: "feature.txt", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [baseCommit], "Feature branch commit", author);
    repo.updateRef("refs/heads/feature", commitHash);

    // 保存初始 main 用于断言未被污染
    const initialMain = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/main"], tempDir);

    // 不传 refSpecs，使用默认行为
    const result = await repo.push(serverUrl);

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.pushedRefs[0]!.refName).toBe("refs/heads/feature");

    // 验证服务端 refs/heads/feature 被正确更新
    const serverRef = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/feature"], tempDir);
    expect(serverRef).toBe(commitHash);

    // 验证服务端 main 没有被意外修改
    const serverMainRef = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/heads/main"],
      tempDir,
    );
    expect(serverMainRef).toBe(initialMain);
  });

  test("默认 refspec 在 HEAD 在 main 分支时正确推送到 main", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 获取服务端初始 commit
    const initialCommit = sha1(
      git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/main"], tempDir),
    );

    // 在 main 上创建新 commit
    const fileHash = repo.writeBlob(Buffer.from("main update"));
    const treeHash = repo.createTree([{ mode: "100644", name: "update.txt", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [initialCommit], "Main update", author);
    repo.updateRef("refs/heads/main", commitHash);

    // HEAD 默认指向 main，不传 refSpecs 应推送到 main
    const result = await repo.push(serverUrl);

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.pushedRefs[0]!.refName).toBe("refs/heads/main");

    const serverRef = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/main"], tempDir);
    expect(serverRef).toBe(commitHash);
  });

  test("默认 refspec 在 detached HEAD 时抛出错误", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 创建一个 commit
    const fileHash = repo.writeBlob(Buffer.from("detached content"));
    const treeHash = repo.createTree([{ mode: "100644", name: "detached.txt", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Detached commit", author);

    // HEAD 直接指向 commit（detached HEAD 状态）
    repo.refs.write(HEAD_REF, commitHash);

    // 不传 refSpecs 时，detached HEAD 应该报错
    const pushPromise = repo.push(serverUrl);
    expect(pushPromise).rejects.toThrow(/detached HEAD|not on a branch|current branch/i);
  });

  test("side-band report-status 跨帧分片时仍能正确解析 push 结果", async () => {
    await server.stop();
    server = startGitHttpBackendServer(tempDir, "/server.git", undefined, {
      transformResponse(response, request) {
        if (request.method === "POST" && request.path.endsWith("/git-receive-pack")) {
          return rewriteReceivePackResponseAsSplitSideBand(response);
        }
        return response;
      },
    });
    serverUrl = server.url;

    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const fileHash = repo.writeBlob(Buffer.from("split side-band push"));
    const treeHash = repo.createTree([{ mode: "100644", name: "split.txt", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Split side-band", author);
    repo.updateRef("refs/heads/split-side-band", commitHash);

    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/split-side-band:refs/heads/split-side-band"],
    });

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
    expect(result.pushedRefs[0]!.refName).toBe("refs/heads/split-side-band");
    expect(result.progress).toContain("remote: side-band progress");

    const serverRef = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/heads/split-side-band"],
      tempDir,
    );
    expect(serverRef).toBe(commitHash);
  });

  test("repo.push() 可透传 token/headers", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const fileHash = repo.writeBlob(Buffer.from("auth test"));
    const treeHash = repo.createTree([{ mode: "100644", name: "auth.txt", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "auth options test", author);
    repo.updateRef("refs/heads/auth-test", commitHash);

    // 透传 token/headers 应被接收（服务器不强制认证时仍成功）
    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/auth-test:refs/heads/auth-test"],
      token: "fake-token",
      headers: { "X-Custom": "yes" },
    });

    expect(result.pushedRefs).toHaveLength(1);
    expect(result.pushedRefs[0]!.success).toBe(true);
  });

  test("pushShallowBoundaries 显式覆盖 backend.shallow（含空数组）", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 父提交仅存在于服务端 main，本地缺失（典型 shallow 边界）
    const missingParent = sha1(
      git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/main"], tempDir).trim(),
    );

    const fileHash = repo.writeBlob(Buffer.from("shallow boundary test"));
    const treeHash = repo.createTree([{ mode: "100644", name: "sb.txt", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [missingParent], "boundary test", author);
    repo.updateRef("refs/heads/boundary-test", commitHash);

    repo.backend.shallow.applyUpdate({ shallow: [missingParent], unshallow: [] });

    const refSpec = ["refs/heads/boundary-test:refs/heads/boundary-test"];

    // 显式 [] 覆盖 backend，不再把 missingParent 当 shallow 边界 → 本地对象缺失预检失败
    const pushWithEmptyOverride = repo.push(serverUrl, {
      refSpecs: refSpec,
      pushShallowBoundaries: [],
    });
    expect(pushWithEmptyOverride).rejects.toThrow(/missing from the local store/i);

    // 未传 override 时回退 backend.shallow，缺失 parent 在边界内可推送（服务端已有 parent）
    const withBackendShallow = await repo.push(serverUrl, { refSpecs: refSpec });
    expect(withBackendShallow.pushedRefs).toHaveLength(1);
    expect(withBackendShallow.pushedRefs[0]!.success).toBe(true);

    // 显式传入边界集合时覆盖 backend（与 backend 内容一致也应成功）
    const withExplicitBoundary = await repo.push(serverUrl, {
      refSpecs: refSpec,
      pushShallowBoundaries: [missingParent],
    });
    expect(withExplicitBoundary.pushedRefs).toHaveLength(1);
    expect(withExplicitBoundary.pushedRefs[0]!.success).toBe(true);
  });
});
