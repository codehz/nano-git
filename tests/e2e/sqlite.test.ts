/**
 * SQLite 仓库端到端测试
 *
 * 覆盖 SQLite 后端在持久化、HTTP 服务端、HTTP 客户端场景下的完整链路。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";

import { createTempDir, cleanupDir, gitWithTimeout, FIXED_AUTHOR } from "./helpers.ts";
import { createDefaultBackend, startNanoGitServer } from "./transport/nano-git-server.ts";
import { createSqliteRepositoryBackend, type SqliteRepositoryBackend } from "@/backend/sqlite.ts";
import { createRepository } from "@/repository/create.ts";
import { createSqliteRepository } from "@/repository/sqlite.ts";

import type { NanoGitServer } from "./transport/nano-git-server.ts";
import type { GitAuthor, SHA1 } from "@/core/types.ts";
import type { Repository } from "@/repository/types.ts";

const GIT_TIMEOUT_MS = 15000;
const GIT_V2_ARGS = ["-c", "protocol.version=2"];

const testAuthor: GitAuthor = {
  name: FIXED_AUTHOR.name,
  email: FIXED_AUTHOR.email,
  timestamp: FIXED_AUTHOR.timestamp,
  timezone: FIXED_AUTHOR.timezone,
};

function slugifyFileName(message: string): string {
  return `${message.toLowerCase().replaceAll(/\s+/g, "-")}.txt`;
}

function appendCommit(repo: Repository, message: string, parents: SHA1[] = []): SHA1 {
  const blobHash = repo.writeBlob(Buffer.from(`${message}\n`));
  const treeHash = repo.createTree([
    {
      mode: "100644",
      name: slugifyFileName(message),
      hash: blobHash,
    },
  ]);
  return repo.createCommit(treeHash, parents, message, testAuthor);
}

describe("SQLite 仓库持久化", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-sqlite-persist");
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  test("对象、refs、tag、shallow 与 gc 结果在重开后保持一致", () => {
    const dbPath = join(tempDir, "repo.sqlite");
    let commitHash: SHA1;
    let tagHash: SHA1;
    let danglingBlobHash: SHA1;

    {
      using repo = createSqliteRepository(dbPath);

      commitHash = appendCommit(repo, "SQLite persistent commit");
      repo.updateRef("refs/heads/main", commitHash);
      repo.createBranch("release", commitHash);
      tagHash = repo.createAnnotatedTag("v1.0.0", commitHash, "SQLite release", testAuthor);
      repo.shallow.write([commitHash]);

      danglingBlobHash = repo.writeBlob(Buffer.from("dangling object"));
      const reachable = repo.listReachableObjects();
      expect(reachable).toContain(commitHash);
      expect(reachable).not.toContain(danglingBlobHash);
    }

    {
      using repo = createSqliteRepository(dbPath);

      expect(repo.readRef("HEAD")).toBe(commitHash!);
      expect(repo.readBranch("main")).toBe(commitHash!);
      expect(repo.readBranch("release")).toBe(commitHash!);
      expect(repo.readTag("v1.0.0")).toBe(tagHash!);
      expect(repo.listTags()).toEqual(["v1.0.0"]);
      expect(repo.shallow.read()).toEqual([commitHash!]);

      const commit = repo.catFile(commitHash!);
      expect(commit.type).toBe("commit");
      if (commit.type === "commit") {
        expect(commit.message).toBe("SQLite persistent commit");
      }

      const tag = repo.catFile(tagHash!);
      expect(tag.type).toBe("tag");
      if (tag.type === "tag") {
        expect(tag.object).toBe(commitHash!);
        expect(tag.message).toBe("SQLite release");
      }

      expect(repo.objects.exists(danglingBlobHash!)).toBe(true);
      expect(repo.gc()).toBeUndefined();
      expect(repo.objects.exists(danglingBlobHash!)).toBe(false);
      expect(repo.objects.exists(commitHash!)).toBe(true);
    }
  });
});

describe("SQLite 后端作为 Smart HTTP 服务端", () => {
  let tempDir: string;
  let server: NanoGitServer | undefined;
  let backend: SqliteRepositoryBackend | undefined;

  beforeEach(() => {
    tempDir = createTempDir("e2e-sqlite-server");
  });

  afterEach(() => {
    server?.stop();
    backend?.[Symbol.dispose]();
    cleanupDir(tempDir);
  });

  test("git clone / fetch 能完整读取 SQLite 服务端仓库", async () => {
    backend = createSqliteRepositoryBackend(join(tempDir, "server.sqlite"));
    const repo = createRepository(backend);

    const firstCommit = appendCommit(repo, "SQLite server initial");
    repo.updateRef("refs/heads/main", firstCommit);
    repo.createBranch("feature/api", firstCommit);
    const annotatedTagHash = repo.createAnnotatedTag(
      "v1.0.0",
      firstCommit,
      "tag from sqlite server",
      testAuthor,
    );

    server = startNanoGitServer(backend);

    const cloneDir = join(tempDir, "clone");
    await gitWithTimeout([...GIT_V2_ARGS, "clone", server.url, cloneDir], tempDir, GIT_TIMEOUT_MS);

    const clonedHead = await gitWithTimeout(
      [...GIT_V2_ARGS, "rev-parse", "HEAD"],
      cloneDir,
      GIT_TIMEOUT_MS,
    );
    expect(clonedHead).toBe(firstCommit);

    const remoteBranches = await gitWithTimeout(
      [...GIT_V2_ARGS, "branch", "-r"],
      cloneDir,
      GIT_TIMEOUT_MS,
    );
    expect(remoteBranches).toContain("origin/feature/api");

    const tagHash = await gitWithTimeout(
      [...GIT_V2_ARGS, "rev-parse", "refs/tags/v1.0.0"],
      cloneDir,
      GIT_TIMEOUT_MS,
    );
    expect(tagHash).toBe(annotatedTagHash);

    const peeledTagTarget = await gitWithTimeout(
      [...GIT_V2_ARGS, "rev-parse", "refs/tags/v1.0.0^{}"],
      cloneDir,
      GIT_TIMEOUT_MS,
    );
    expect(peeledTagTarget).toBe(firstCommit);

    const fileContent = await gitWithTimeout(
      [...GIT_V2_ARGS, "show", "HEAD:sqlite-server-initial.txt"],
      cloneDir,
      GIT_TIMEOUT_MS,
    );
    expect(fileContent).toBe("SQLite server initial");

    const secondCommit = appendCommit(repo, "SQLite server second", [firstCommit]);
    repo.updateRef("refs/heads/main", secondCommit);

    await gitWithTimeout([...GIT_V2_ARGS, "fetch", "origin"], cloneDir, GIT_TIMEOUT_MS);

    const remoteMain = await gitWithTimeout(
      [...GIT_V2_ARGS, "rev-parse", "origin/main"],
      cloneDir,
      GIT_TIMEOUT_MS,
    );
    expect(remoteMain).toBe(secondCommit);
  });
});

describe("SQLite 仓库作为 HTTP 客户端", () => {
  let tempDir: string;
  let server: NanoGitServer;

  beforeEach(() => {
    tempDir = createTempDir("e2e-sqlite-client");
    server = startNanoGitServer(createDefaultBackend());
  });

  afterEach(() => {
    server.stop();
    cleanupDir(tempDir);
  });

  test("fetch 导入的对象和 refs 在重开后保持可用，并支持增量拉取", async () => {
    const remoteRepo = createRepository(server.backend);
    const firstCommit = server.backend.refs.read("refs/heads/main") as SHA1;
    remoteRepo.createBranch("feature/api", firstCommit);
    const annotatedTagHash = remoteRepo.createAnnotatedTag(
      "v1.0.0",
      firstCommit,
      "client import tag",
      testAuthor,
    );

    const dbPath = join(tempDir, "client.sqlite");

    {
      using repo = createSqliteRepository(dbPath);

      const result = await repo.fetch(server.url);
      expect(result.objectCount).toBeGreaterThan(0);
      expect(repo.readRef("HEAD")).toBe(firstCommit);
      expect(repo.readBranch("main")).toBe(firstCommit);
      expect(repo.readBranch("feature/api")).toBe(firstCommit);
      expect(repo.readTag("v1.0.0")).toBe(annotatedTagHash);
    }

    {
      using repo = createSqliteRepository(dbPath);

      expect(repo.readRef("HEAD")).toBe(firstCommit);
      expect(repo.readBranch("feature/api")).toBe(firstCommit);
      expect(repo.readTag("v1.0.0")).toBe(annotatedTagHash);

      const importedCommit = repo.catFile(firstCommit);
      expect(importedCommit.type).toBe("commit");

      const secondCommit = appendCommit(remoteRepo, "SQLite client second", [firstCommit]);
      remoteRepo.updateRef("refs/heads/main", secondCommit);

      const result = await repo.fetch(server.url);
      expect(result.updatedRefs.some((item) => item.refName === "refs/heads/main")).toBe(true);
      expect(repo.readRef("HEAD")).toBe(secondCommit);
      expect(repo.readBranch("main")).toBe(secondCommit);

      const newCommit = repo.catFile(secondCommit);
      expect(newCommit.type).toBe("commit");
      if (newCommit.type === "commit") {
        expect(newCommit.parents).toEqual([firstCommit]);
        expect(newCommit.message).toBe("SQLite client second");
      }
    }
  });
});
