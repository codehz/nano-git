/**
 * SQLite 仓库便捷创建函数单元测试
 */

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bytes, bytesToUtf8 } from "../../helpers/bytes.ts";
import { openTestSqlite } from "../../helpers/sqlite.ts";
import { createSqliteRepository } from "@/repository/sqlite.ts";

describe("createSqliteRepository()", () => {
  const dbPaths: string[] = [];

  afterEach(() => {
    for (const p of dbPaths) {
      if (existsSync(p)) unlinkSync(p);
    }
    dbPaths.length = 0;
  });

  function tmpPath(): string {
    const p = join(tmpdir(), `nano-git-sqlite-repo-${Date.now()}-${Math.random()}.sqlite`);
    dbPaths.push(p);
    return p;
  }

  test("返回完整的 Repository 接口", () => {
    using db = openTestSqlite(tmpPath());
    const repo = createSqliteRepository(db);
    expect(repo).toHaveProperty("objects");
    expect(repo).toHaveProperty("refs");
    expect(repo).toHaveProperty("shallow");
    expect(repo).toHaveProperty("gitDir");
    expect(repo.gitDir).toBe("");
  });

  test("writeBlob + catFile 正常", () => {
    using db = openTestSqlite(tmpPath());
    const repo = createSqliteRepository(db);
    const hash = repo.writeBlob(bytes("hello sqlite"));
    const obj = repo.catFile(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(bytesToUtf8(obj.content)).toBe("hello sqlite");
    }
  });

  test("getCurrentBranch 默认返回 main", () => {
    using db = openTestSqlite(tmpPath());
    const repo = createSqliteRepository(db);
    expect(repo.getCurrentBranch()).toBe("main");
  });

  test("createBranch + listBranches", () => {
    using db = openTestSqlite(tmpPath());
    const repo = createSqliteRepository(db);
    const treeHash = repo.createTree([]);
    repo.createBranch("feature", treeHash);

    const branches = repo.listBranches();
    expect(branches).toContain("feature");
  });

  test("关闭后再打开同一数据库文件可读取已有数据", () => {
    const path = tmpPath();
    const blobHash = (() => {
      using db = openTestSqlite(path);
      const repo = createSqliteRepository(db);
      return repo.writeBlob(bytes("persist"));
    })();

    using db2 = openTestSqlite(path);
    const repo2 = createSqliteRepository(db2);
    const obj = repo2.catFile(blobHash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(bytesToUtf8(obj.content)).toBe("persist");
    }
    expect(repo2.objects.exists(blobHash)).toBe(true);
  });
});
