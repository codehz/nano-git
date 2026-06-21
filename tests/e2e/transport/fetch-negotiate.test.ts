/**
 * Fetch 协商流程测试
 *
 * 验证增量 fetch 中的 have/want 协商逻辑，包括多轮协商（超过 32 个 haves）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import { join } from "node:path";

import { git, createTempDir, cleanupDir, createFile } from "../helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";

import { sha1 } from "../../../src/core/types.ts";
import { initRepository } from "../../../src/repository/index.ts";
import {
  createServerRepo,
  decodeUploadPackCommands,
  countFlushPackets,
  getUploadPackRequests,
} from "./helpers.ts";

describe("fetch 协商流程", () => {
  let tempDir: string;
  let repoDir: string;
  let projectRoot: string;
  let workDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-http-fetch-negotiate");
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
    const localDir = join(tempDir, "local-http-incremental");
    const repo = initRepository(localDir);

    const initialHead = git(["rev-parse", "HEAD"], workDir);
    const result1 = await repo.fetch(serverUrl);
    expect(result1.objectCount).toBeGreaterThan(0);

    const firstUploadPackRequests = getUploadPackRequests(server.requests);
    expect(firstUploadPackRequests).toHaveLength(1);
    const firstCommands = decodeUploadPackCommands(firstUploadPackRequests[0]!.body);
    expect(firstCommands.some((line) => line.startsWith("have "))).toBe(false);

    server.clearRequests();

    createFile(workDir, "src/http-feature-a.ts", 'export const a = "a";\n');
    git(["add", "src/http-feature-a.ts"], workDir);
    git(["commit", "-m", "Add HTTP feature a"], workDir);

    createFile(workDir, "src/http-feature-b.ts", 'export const b = "b";\n');
    git(["add", "src/http-feature-b.ts"], workDir);
    git(["commit", "-m", "Add HTTP feature b"], workDir);

    const newHead = git(["rev-parse", "HEAD"], workDir);
    git(["push", repoDir, "main"], workDir);
    const expectedNewObjects = git(
      ["rev-list", "--objects", "--no-object-names", `${initialHead}..${newHead}`],
      workDir,
    )
      .split("\n")
      .filter((line) => line.length > 0).length;

    const result2 = await repo.fetch(serverUrl);

    expect(result2.objectCount).toBeGreaterThan(0);
    expect(result2.objectCount).toBe(expectedNewObjects);
    expect(result2.fetchedRefs.get("refs/remotes/origin/main")).toBe(sha1(newHead));

    const secondUploadPackRequests = getUploadPackRequests(server.requests);
    expect(secondUploadPackRequests).toHaveLength(1);
    const secondCommands = decodeUploadPackCommands(secondUploadPackRequests[0]!.body);
    expect(secondCommands.some((line) => line === `have ${initialHead}`)).toBe(true);
    expect(secondCommands.some((line) => line.startsWith(`want ${newHead}`))).toBe(true);
  });

  test("增量 fetch：超过 32 个 haves 时使用多轮协商", async () => {
    const localDir = join(tempDir, "local-http-batched-haves");
    const repo = initRepository(localDir);

    const totalInitialCommits = 36;
    for (let i = 0; i < totalInitialCommits; i++) {
      createFile(workDir, `history/http-commit-${i}.txt`, `commit-${i}\n`);
      git(["add", `history/http-commit-${i}.txt`], workDir);
      git(["commit", "-m", `HTTP history commit ${i}`], workDir);
    }
    git(["push", repoDir, "main"], workDir);

    const result1 = await repo.fetch(serverUrl);
    expect(result1.objectCount).toBeGreaterThan(totalInitialCommits);

    server.clearRequests();

    createFile(workDir, "history/http-new-a.txt", "new-a\n");
    git(["add", "history/http-new-a.txt"], workDir);
    git(["commit", "-m", "HTTP new history a"], workDir);

    createFile(workDir, "history/http-new-b.txt", "new-b\n");
    git(["add", "history/http-new-b.txt"], workDir);
    git(["commit", "-m", "HTTP new history b"], workDir);

    const newHead = git(["rev-parse", "HEAD"], workDir);
    git(["push", repoDir, "main"], workDir);

    const result2 = await repo.fetch(serverUrl);

    expect(result2.objectCount).toBeGreaterThan(0);
    expect(result2.objectCount).toBeLessThan(result1.objectCount);
    expect(result2.fetchedRefs.get("refs/remotes/origin/main")).toBe(sha1(newHead));

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
    expect(new Set(sentHaves).size).toBe(sentHaves.length);
    expect(countFlushPackets(thirdBody)).toBe(1);
    expect(thirdCommands.at(-1)).toBe("done");

    const mainRef = repo.refs.readRaw("refs/remotes/origin/main");
    expect(mainRef).toBe(newHead);
    expect(repo.objects.read(sha1(newHead)).type).toBe("commit");
  });
});
