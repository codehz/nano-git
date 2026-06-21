/**
 * 文件系统仓库 ref 操作测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha1 } from "@/core/types.ts";
import { initRepository, type Repository } from "@/repository/index.ts";

import type { GitAuthor } from "@/core/types.ts";

const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

describe("文件系统仓库的 ref 操作", () => {
  let tempDir: string;
  let repo: Repository;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nano-git-repo-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
    repo = initRepository(tempDir);
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("updateRef() 和 readRef() 配合工作", () => {
    const hash = sha1("1111111111111111111111111111111111111111");
    repo.updateRef("refs/heads/main", hash);
    expect(repo.readRef("refs/heads/main")).toBe(hash);
  });

  test("readRef() 解析符号引用（HEAD）", () => {
    const hash = sha1("2222222222222222222222222222222222222222");
    repo.updateRef("refs/heads/main", hash);
    // HEAD -> refs/heads/main -> hash
    expect(repo.readRef("HEAD")).toBe(hash);
  });

  test("readRef() 对不存在的 ref 返回 null", () => {
    expect(repo.readRef("refs/heads/nonexistent")).toBeNull();
  });

  test("getCurrentBranch() 返回当前分支名", () => {
    expect(repo.getCurrentBranch()).toBe("main");
  });

  test("createBranch() 默认从 HEAD 创建分支", () => {
    const treeHash = repo.createTree([]);
    const commitHash = repo.createCommit(treeHash, [], "base", testAuthor);
    repo.updateRef("refs/heads/main", commitHash);

    repo.createBranch("feature");
    expect(repo.readBranch("feature")).toBe(commitHash);
  });

  test("listBranches() 返回排序后的分支名", () => {
    const hash1 = sha1("3333333333333333333333333333333333333333");
    const hash2 = sha1("4444444444444444444444444444444444444444");
    repo.createBranch("z-last", hash1);
    repo.createBranch("feature/api", hash2);

    expect(repo.listBranches()).toEqual(["feature/api", "z-last"]);
  });

  test("deleteBranch() 删除分支 ref", () => {
    const hash = sha1("5555555555555555555555555555555555555555");
    repo.createBranch("feature/delete", hash);

    repo.deleteBranch("feature/delete");
    expect(repo.readBranch("feature/delete")).toBeNull();
  });

  test("createTag() 默认从 HEAD 创建轻量标签", () => {
    const treeHash = repo.createTree([]);
    const commitHash = repo.createCommit(treeHash, [], "release", testAuthor);
    repo.updateRef("refs/heads/main", commitHash);

    repo.createTag("v1.0.0");
    expect(repo.readTag("v1.0.0")).toBe(commitHash);
  });

  test("createAnnotatedTag() 创建 annotated tag", () => {
    const treeHash = repo.createTree([]);
    const commitHash = repo.createCommit(treeHash, [], "release", testAuthor);

    const tagHash = repo.createAnnotatedTag("v2.0.0", commitHash, "Version 2.0.0\n", testAuthor);

    expect(repo.readTag("v2.0.0")).toBe(tagHash);

    const tag = repo.catFile(tagHash);
    expect(tag.type).toBe("tag");
    if (tag.type === "tag") {
      expect(tag.object).toBe(commitHash);
      expect(tag.objectType).toBe("commit");
      expect(tag.tag).toBe("v2.0.0");
    }
  });

  test("listTags() 返回排序后的标签名", () => {
    const hash1 = sha1("6666666666666666666666666666666666666666");
    const hash2 = sha1("7777777777777777777777777777777777777777");
    repo.createTag("v2.0.0", hash2);
    repo.createTag("v1.0.0", hash1);

    expect(repo.listTags()).toEqual(["v1.0.0", "v2.0.0"]);
  });

  test("deleteTag() 删除标签 ref", () => {
    const hash = sha1("8888888888888888888888888888888888888888");
    repo.createTag("v9.9.9", hash);

    repo.deleteTag("v9.9.9");
    expect(repo.readTag("v9.9.9")).toBeNull();
  });

  test("updateRef() 拒绝非法 ref 名", () => {
    const hash = sha1("9999999999999999999999999999999999999999");
    expect(() => repo.updateRef("refs/heads/../../escape", hash)).toThrow("Invalid ref name");
  });
});
