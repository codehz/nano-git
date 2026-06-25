/**
 * Virtual Workdir 持久化示例
 *
 * 展示：
 * 1. 如何直接打开 file 持久化 workdir
 * 2. 如何直接打开 sqlite 持久化 workdir
 */

import { createMemoryRepository } from "nano-git/repository/memory";
import { deleteFileVirtualWorkdir, openFileVirtualWorkdir } from "nano-git/workdir/file";
import { deleteSqliteVirtualWorkdir, openSqliteVirtualWorkdir } from "nano-git/workdir/sqlite";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createFixture() {
  const repo = createMemoryRepository();
  const readme = repo.writeBlob(Buffer.from("base\n"));
  const baseTree = repo.createTree([{ mode: "100644", name: "README.md", hash: readme }]);
  return { repo, baseTree };
}

function runFileDemo(): void {
  const rootDir = mkdtempSync(join(tmpdir(), "nano-git-workdir-file-demo-"));
  const { repo, baseTree } = createFixture();

  try {
    const workdir = openFileVirtualWorkdir(repo.objects, rootDir, {
      baseTree,
      create: true,
    });

    workdir.writeFile("README.md", Buffer.from("file backend\n"));
    workdir.mkdir("src");
    workdir.writeFile("src/index.ts", Buffer.from("export const answer = 42;\n"));

    console.log("=== file workdir ===");
    console.log(`writeTree(): ${workdir.writeTree()}`);

    const reopened = openFileVirtualWorkdir(repo.objects, rootDir, { baseTree });
    console.log(`reopen README.md: ${reopened.readFile("README.md").toString().trim()}`);
    console.log(`reopen src/index.ts: ${reopened.readFile("src/index.ts").toString().trim()}`);

    deleteFileVirtualWorkdir(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runSqliteDemo(): void {
  const rootDir = mkdtempSync(join(tmpdir(), "nano-git-workdir-sqlite-demo-"));
  const dbPath = join(rootDir, "workdir.sqlite");
  const { repo, baseTree } = createFixture();

  try {
    using workdir = openSqliteVirtualWorkdir(repo.objects, dbPath, "demo", {
      baseTree,
      create: true,
    });

    workdir.writeFile("README.md", Buffer.from("sqlite backend\n"));
    workdir.writeLink("current", "README.md");

    console.log("=== sqlite workdir ===");
    console.log(`writeTree(): ${workdir.writeTree()}`);

    using reopened = openSqliteVirtualWorkdir(repo.objects, dbPath, "demo", { baseTree });
    console.log(`reopen README.md: ${reopened.readFile("README.md").toString().trim()}`);
    console.log(`reopen current -> ${reopened.readLink("current")}`);

    deleteSqliteVirtualWorkdir(dbPath, "demo");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

runFileDemo();
runSqliteDemo();
