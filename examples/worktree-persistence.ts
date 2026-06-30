/**
 * Virtual Worktree 持久化示例
 *
 * 展示：
 * 1. 如何直接打开 file 持久化 worktree
 * 2. 如何直接打开 sqlite 持久化 worktree
 */

import { createMemoryRepository } from "nano-git/repository/memory";
import { deleteFileVirtualWorktree, openFileVirtualWorktree } from "nano-git/worktree/file";
import { deleteSqliteVirtualWorktree, openSqliteVirtualWorktree } from "nano-git/worktree/sqlite";

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
  const rootDir = mkdtempSync(join(tmpdir(), "nano-git-worktree-file-demo-"));
  const { repo, baseTree } = createFixture();

  try {
    const worktree = openFileVirtualWorktree(repo.objects, rootDir, {
      baseTree,
      create: true,
    });

    worktree.writeFile("README.md", Buffer.from("file backend\n"));
    worktree.mkdir("src");
    worktree.writeFile("src/index.ts", Buffer.from("export const answer = 42;\n"));

    console.log("=== file worktree ===");
    console.log(`writeTree(): ${worktree.writeTree()}`);

    const reopened = openFileVirtualWorktree(repo.objects, rootDir, { baseTree });
    console.log(`reopen README.md: ${reopened.readFile("README.md").toString().trim()}`);
    console.log(`reopen src/index.ts: ${reopened.readFile("src/index.ts").toString().trim()}`);

    deleteFileVirtualWorktree(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runSqliteDemo(): void {
  const rootDir = mkdtempSync(join(tmpdir(), "nano-git-worktree-sqlite-demo-"));
  const dbPath = join(rootDir, "worktree.sqlite");
  const { repo, baseTree } = createFixture();

  try {
    using worktree = openSqliteVirtualWorktree(repo.objects, dbPath, "demo", {
      baseTree,
      create: true,
    });

    worktree.writeFile("README.md", Buffer.from("sqlite backend\n"));
    worktree.writeLink("current", "README.md");

    console.log("=== sqlite worktree ===");
    console.log(`writeTree(): ${worktree.writeTree()}`);

    using reopened = openSqliteVirtualWorktree(repo.objects, dbPath, "demo", { baseTree });
    console.log(`reopen README.md: ${reopened.readFile("README.md").toString().trim()}`);
    console.log(`reopen current -> ${reopened.readLink("current")}`);

    deleteSqliteVirtualWorktree(dbPath, "demo");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

runFileDemo();
runSqliteDemo();
