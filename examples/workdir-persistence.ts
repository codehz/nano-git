/**
 * Virtual Workdir 持久化 backend 最小示例
 *
 * 展示：
 * 1. 如何创建 file/sqlite backend
 * 2. 如何创建并 reopen 持久化 session
 * 3. `listSessions()`、`readFile()`、`writeTree()` 的基本语义
 */

import { createMemoryRepository } from "nano-git/repository/memory";
import { createFileVirtualWorkdirBackend } from "nano-git/workdir/file";
import { createSqliteVirtualWorkdirBackend } from "nano-git/workdir/sqlite";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createFixture() {
  const repo = createMemoryRepository();
  const readme = repo.writeBlob(Buffer.from("base\n"));
  const baseTree = repo.createTree([{ mode: "100644", name: "README.md", hash: readme }]);
  return { repo, baseTree };
}

function runFileBackendDemo(): void {
  const rootDir = mkdtempSync(join(tmpdir(), "nano-git-workdir-file-demo-"));
  const { repo, baseTree } = createFixture();

  try {
    const backend = createFileVirtualWorkdirBackend(rootDir);
    const sessionId = backend.createSession({ baseTree });
    const session = backend.openSession(repo.objects, sessionId);

    session.writeFile("README.md", Buffer.from("file backend\n"));
    session.mkdir("src");
    session.writeFile("src/index.ts", Buffer.from("export const answer = 42;\n"));

    console.log("=== file backend ===");
    console.log(`sessionId: ${sessionId}`);
    console.log(`listSessions(): ${backend.listSessions().join(", ")}`);
    console.log(`writeTree(): ${session.writeTree()}`);

    const reopenedBackend = createFileVirtualWorkdirBackend(rootDir);
    const reopenedSession = reopenedBackend.openSession(repo.objects, sessionId);
    console.log(`reopen README.md: ${reopenedSession.readFile("README.md").toString().trim()}`);
    console.log(
      `reopen src/index.ts: ${reopenedSession.readFile("src/index.ts").toString().trim()}`,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runSqliteBackendDemo(): void {
  const rootDir = mkdtempSync(join(tmpdir(), "nano-git-workdir-sqlite-demo-"));
  const dbPath = join(rootDir, "workdir.sqlite");
  const { repo, baseTree } = createFixture();

  try {
    using backend = createSqliteVirtualWorkdirBackend(dbPath);
    const sessionId = backend.createSession({ baseTree });
    const session = backend.openSession(repo.objects, sessionId);

    session.writeFile("README.md", Buffer.from("sqlite backend\n"));
    session.writeLink("current", "README.md");

    console.log("=== sqlite backend ===");
    console.log(`sessionId: ${sessionId}`);
    console.log(`listSessions(): ${backend.listSessions().join(", ")}`);
    console.log(`writeTree(): ${session.writeTree()}`);

    using reopenedBackend = createSqliteVirtualWorkdirBackend(dbPath);
    const reopenedSession = reopenedBackend.openSession(repo.objects, sessionId);
    console.log(`reopen README.md: ${reopenedSession.readFile("README.md").toString().trim()}`);
    console.log(`reopen current -> ${reopenedSession.readLink("current")}`);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

runFileBackendDemo();
runSqliteBackendDemo();
