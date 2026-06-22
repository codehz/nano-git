/**
 * 内存仓库单元测试
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { sha1, type SHA1 } from "@/core/types.ts";
import { createMemoryRepository, type Repository } from "@/repository/index.ts";
import {
  resolveEffectivePushUrl,
  resolveEffectivePushRefSpecs,
  resolveEffectivePushBoundaries,
} from "@/repository/remote-resolution.ts";

import type { GitAuthor } from "@/core/types.ts";
import type { RemoteConfig, PushRemoteOptions } from "@/repository/remote-types.ts";

const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

describe("createMemoryRepository()", () => {
  let repo: Repository;

  beforeEach(() => {
    repo = createMemoryRepository();
  });

  test("gitDir 为 null", () => {
    expect(repo.gitDir).toBeNull();
  });

  test("hashObject() 计算 blob 哈希（不写入存储）", () => {
    const hash = repo.hashObject(Buffer.from("hello world"));
    expect(hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));
    // hashObject 不写入存储，所以 catFile 应该抛出异常
    expect(() => repo.catFile(hash)).toThrow("Object not found");
  });

  test("writeBlob() 写入并返回哈希", () => {
    const hash = repo.writeBlob(Buffer.from("hello world"));
    expect(hash).toBe(sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"));

    const obj = repo.catFile(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("hello world");
    }
  });

  test("catFileType() 返回正确的对象类型", () => {
    const blobHash = repo.writeBlob(Buffer.from("test"));
    expect(repo.catFileType(blobHash)).toBe("blob");

    const treeHash = repo.createTree([]);
    expect(repo.catFileType(treeHash)).toBe("tree");
  });

  test("createTree() 创建 tree 对象", () => {
    const fileHash = repo.writeBlob(Buffer.from("content"));
    const treeHash = repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]);

    const tree = repo.catFile(treeHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("file.txt");
      expect(tree.entries[0]!.mode).toBe("100644");
      expect(tree.entries[0]!.hash).toBe(fileHash);
    }
  });

  test("createCommit() 创建 commit 对象", () => {
    const treeHash = repo.createTree([]);
    const commitHash = repo.createCommit(treeHash, [], "Initial commit", testAuthor);

    const commit = repo.catFile(commitHash);
    expect(commit.type).toBe("commit");
    if (commit.type === "commit") {
      expect(commit.tree).toBe(treeHash);
      expect(commit.parents).toHaveLength(0);
      expect(commit.message).toBe("Initial commit");
      expect(commit.author.name).toBe("Test User");
      expect(commit.committer.name).toBe("Test User");
    }
  });

  test("createCommit() 使用单独的 committer", () => {
    const treeHash = repo.createTree([]);
    const committer: GitAuthor = {
      name: "Committer",
      email: "committer@example.com",
      timestamp: 1700000001,
      timezone: "+0000",
    };

    const commitHash = repo.createCommit(treeHash, [], "Test", testAuthor, committer);

    const commit = repo.catFile(commitHash);
    if (commit.type === "commit") {
      expect(commit.author.name).toBe("Test User");
      expect(commit.committer.name).toBe("Committer");
    }
  });

  test("createCommit() 支持父 commit", () => {
    const treeHash = repo.createTree([]);
    const parentHash = repo.createCommit(treeHash, [], "First", testAuthor);
    const childHash = repo.createCommit(treeHash, [parentHash], "Second", testAuthor);

    const child = repo.catFile(childHash);
    if (child.type === "commit") {
      expect(child.parents).toHaveLength(1);
      expect(child.parents[0]).toBe(parentHash);
    }
  });

  test("内存仓库支持 updateRef() 和 readRef()", () => {
    const hash = sha1("1111111111111111111111111111111111111111");
    repo.updateRef("refs/heads/main", hash);
    expect(repo.readRef("refs/heads/main")).toBe(hash);
  });

  test("内存仓库默认 HEAD 指向 main", () => {
    expect(repo.getCurrentBranch()).toBe("main");
  });

  test("内存仓库的 readRef 对不存在的 ref 返回 null", () => {
    expect(repo.readRef("refs/heads/main")).toBeNull();
  });

  test("createBranch() / listBranches() / deleteBranch() 配合工作", () => {
    const hash = sha1("2222222222222222222222222222222222222222");
    repo.createBranch("feature/test", hash);

    expect(repo.readBranch("feature/test")).toBe(hash);
    expect(repo.listBranches()).toEqual(["feature/test"]);

    repo.deleteBranch("feature/test");
    expect(repo.readBranch("feature/test")).toBeNull();
  });

  test("deleteBranch() 不允许删除当前分支", () => {
    const hash = sha1("3333333333333333333333333333333333333333");
    repo.updateRef("refs/heads/main", hash);

    expect(() => repo.deleteBranch("main")).toThrow("Cannot delete current branch: main");
  });

  test("createTag() / listTags() / deleteTag() 配合工作", () => {
    const hash = sha1("4444444444444444444444444444444444444444");
    repo.createTag("v1.0.0", hash);

    expect(repo.readTag("v1.0.0")).toBe(hash);
    expect(repo.listTags()).toEqual(["v1.0.0"]);

    repo.deleteTag("v1.0.0");
    expect(repo.readTag("v1.0.0")).toBeNull();
  });

  test("createAnnotatedTag() 创建 tag 对象并更新 tag ref", () => {
    const blobHash = repo.writeBlob(Buffer.from("release"));
    const tagHash = repo.createAnnotatedTag("v2.0.0", blobHash, "Release v2.0.0\n", testAuthor);

    expect(repo.readTag("v2.0.0")).toBe(tagHash);

    const tag = repo.catFile(tagHash);
    expect(tag.type).toBe("tag");
    if (tag.type === "tag") {
      expect(tag.object).toBe(blobHash);
      expect(tag.objectType).toBe("blob");
      expect(tag.tag).toBe("v2.0.0");
      expect(tag.message).toBe("Release v2.0.0");
    }
  });
});

// ============================================================================
// PushRemoteOptions 决策测试（含边界回退）
// ============================================================================

describe("resolveEffectivePushBoundaries", () => {
  const sampleShallow: SHA1[] = [sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")];

  test("options.pushShallowBoundaries 优先", () => {
    const opts: Pick<PushRemoteOptions, "pushShallowBoundaries"> = {
      pushShallowBoundaries: [sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")],
    };
    const result = resolveEffectivePushBoundaries(opts, sampleShallow);
    expect(result).toEqual(opts.pushShallowBoundaries);
  });

  test("pushShallowBoundaries: [] 显式覆盖 backend.shallow", () => {
    const result = resolveEffectivePushBoundaries({ pushShallowBoundaries: [] }, sampleShallow);
    expect(result).toEqual([]);
  });

  test("未传 pushShallowBoundaries 时回退 backend.shallow", () => {
    const result = resolveEffectivePushBoundaries({}, sampleShallow);
    expect(result).toBe(sampleShallow);
  });

  test("两者都无时返回 undefined", () => {
    const result = resolveEffectivePushBoundaries(undefined, undefined);
    expect(result).toBeUndefined();
  });

  test("未传 options 且 backend.shallow 为空数组时回退为 []", () => {
    const result = resolveEffectivePushBoundaries(undefined, []);
    expect(result).toEqual([]);
  });
});

describe("resolve push url/refspecs", () => {
  const remote: RemoteConfig = {
    name: "origin",
    url: "https://example.com/repo.git",
    pushUrl: "https://example.com/push.git",
    pushRefSpecs: ["refs/heads/*:refs/heads/*"],
  };

  test("pushUrl 优先级", () => {
    expect(resolveEffectivePushUrl(remote, { pushUrl: "u" })).toBe("u");
    expect(resolveEffectivePushUrl(remote, {})).toBe("https://example.com/push.git");
  });

  test("refSpecs 优先级", () => {
    expect(resolveEffectivePushRefSpecs(remote, { refSpecs: ["a:b"] })).toEqual(["a:b"]);
    expect(resolveEffectivePushRefSpecs(remote, {})).toEqual(["refs/heads/*:refs/heads/*"]);
  });
});
