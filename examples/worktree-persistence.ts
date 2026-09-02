/**
 * Virtual Worktree 持久化示例
 *
 * 展示：
 * 1. 如何直接打开 file 持久化 worktree
 * 2. 如何直接打开 sqlite 持久化 worktree
 */

import { createMemoryRepository } from "nano-git/repository/memory";
import {
  createFileVirtualWorktree,
  deleteFileVirtualWorktree,
  openFileVirtualWorktree,
} from "nano-git/worktree/file";
import { openSqliteVirtualWorktreeDatabase } from "nano-git/worktree/sqlite";

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bytes, bytesToUtf8 } from "../tests/helpers/bytes.ts";

import type { SqliteDatabase } from "nano-git/types/sqlite";

function createFixture() {
  const repo = createMemoryRepository();
  const readme = repo.writeBlob(bytes("base\n"));
  const baseTree = repo.createTree([{ mode: "100644", name: "README.md", hash: readme }]);
  return { repo, baseTree };
}

function runFileDemo(): void {
  const rootDir = mkdtempSync(join(tmpdir(), "nano-git-worktree-file-demo-"));
  const { repo, baseTree } = createFixture();

  try {
    createFileVirtualWorktree(rootDir, { baseTree });
    const worktree = openFileVirtualWorktree(repo.objects, rootDir);

    worktree.writeFile("README.md", bytes("file backend\n"));
    worktree.mkdir("src");
    worktree.writeFile("src/index.ts", bytes("export const answer = 42;\n"));

    console.log("=== file worktree ===");
    console.log(`writeTree(): ${worktree.writeTree()}`);

    const reopened = openFileVirtualWorktree(repo.objects, rootDir);
    console.log(`reopen README.md: ${bytesToUtf8(reopened.readFile("README.md")).trim()}`);
    console.log(`reopen src/index.ts: ${bytesToUtf8(reopened.readFile("src/index.ts")).trim()}`);

    deleteFileVirtualWorktree(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runSqliteDemo(): void {
  const rootDir = mkdtempSync(join(tmpdir(), "nano-git-worktree-sqlite-demo-"));
  const dbPath = join(rootDir, "worktree.sqlite");
  const { repo, baseTree } = createFixture();
  const sqlite = new Database(dbPath) as unknown as SqliteDatabase;

  try {
    const db = openSqliteVirtualWorktreeDatabase(sqlite);
    db.createWorktree("demo", { baseTree });
    const worktree = db.openWorktree(repo.objects, "demo");

    worktree.writeFile("README.md", bytes("sqlite backend\n"));
    worktree.writeLink("current", "README.md");

    console.log("=== sqlite worktree ===");
    console.log(`writeTree(): ${worktree.writeTree()}`);
    console.log(`keys: ${db.listWorktreeKeys().join(", ")}`);

    const reopened = db.openWorktree(repo.objects, "demo");
    console.log(`reopen README.md: ${bytesToUtf8(reopened.readFile("README.md")).trim()}`);
    console.log(`reopen current -> ${reopened.readLink("current")}`);

    db.deleteWorktree("demo");
  } finally {
    (sqlite as unknown as Database).close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

runFileDemo();
runSqliteDemo();
