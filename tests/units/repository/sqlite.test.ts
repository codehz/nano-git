/**
 * SQLite 仓库便捷创建函数单元测试
 */

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    using repo = createSqliteRepository(tmpPath());
    expect(repo).toHaveProperty("objects");
    expect(repo).toHaveProperty("refs");
    expect(repo).toHaveProperty("shallow");
    expect(repo).toHaveProperty("gitDir");
    expect(repo.gitDir).not.toBeNull();
  });

  test("writeBlob + catFile 正常", () => {
    using repo = createSqliteRepository(tmpPath());
    const hash = repo.writeBlob(Buffer.from("hello sqlite"));
    const obj = repo.catFile(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("hello sqlite");
    }
  });

  test("getCurrentBranch 默认返回 main", () => {
    using repo = createSqliteRepository(tmpPath());
    expect(repo.getCurrentBranch()).toBe("main");
  });

  test("createBranch + listBranches", () => {
    using repo = createSqliteRepository(tmpPath());
    const treeHash = repo.createTree([]);
    repo.createBranch("feature", treeHash);

    const branches = repo.listBranches();
    expect(branches).toContain("feature");
  });

  test("支持 Symbol.dispose", () => {
    const repo = createSqliteRepository(tmpPath());
    expect(typeof repo[Symbol.dispose]).toBe("function");
    repo[Symbol.dispose]();
  });

  test("dispose 后数据库文件可被重新打开", () => {
    const path = tmpPath();
    const blobHash = (() => {
      using repo = createSqliteRepository(path);
      return repo.writeBlob(Buffer.from("persist"));
    })();

    // 重新打开同一文件，确认先前写入的数据仍可读取
    using repo2 = createSqliteRepository(path);
    const obj = repo2.catFile(blobHash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("persist");
    }
    expect(repo2.objects.exists(blobHash)).toBe(true);
  });
});
