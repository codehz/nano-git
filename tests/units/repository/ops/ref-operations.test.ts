/**
 * repository/ops/ref-operations.ts 单元测试
 */

import { describe, test, expect } from "bun:test";

import { createMemoryRepositoryBackend } from "@/backend/memory-backend.ts";
import { sha1, type GitAuthor } from "@/core/types.ts";
import { writeObject, readObject } from "@/objects/raw.ts";
import { createRefRepositoryOperations } from "@/repository/ops/ref-operations.ts";

const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

const testHash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");

describe("createRefRepositoryOperations()", () => {
  function createOps() {
    const backend = createMemoryRepositoryBackend();
    const ops = createRefRepositoryOperations(backend);
    return { backend, ops };
  }

  test("updateRef() 写入并 readRef() 读取直接引用", () => {
    const { ops } = createOps();
    ops.updateRef("refs/heads/feature", testHash);
    expect(ops.readRef("refs/heads/feature")).toBe(testHash);
  });

  test("readRef() 不存在的引用返回 null", () => {
    const { ops } = createOps();
    expect(ops.readRef("refs/heads/nonexistent")).toBeNull();
  });

  test("getCurrentBranch() 返回当前分支", () => {
    const { ops } = createOps();
    expect(ops.getCurrentBranch()).toBe("main");
  });

  test("createBranch() 创建新分支", () => {
    const { ops } = createOps();
    ops.createBranch("feature", testHash);
    expect(ops.readBranch("feature")).toBe(testHash);
  });

  test("createBranch() 不指定哈希时引用 HEAD 指向的目标", () => {
    const { ops, backend } = createOps();
    // 直接通过 backend 创建一个 commit 让 HEAD 可以解析
    const blob: import("@/core/types.ts").GitBlob = { type: "blob", content: Buffer.from("c") };
    const blobHash = writeObject(backend.objects, blob);
    const treeHash = writeObject(backend.objects, {
      type: "tree",
      entries: [{ mode: "100644", name: "f", hash: blobHash }],
    });
    const commitHash = writeObject(backend.objects, {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: { name: "T", email: "t@t.com", timestamp: 1, timezone: "+0000" },
      committer: { name: "T", email: "t@t.com", timestamp: 1, timezone: "+0000" },
      message: "init",
    });
    backend.refs.write("refs/heads/main", commitHash);

    ops.createBranch("feature");
    expect(ops.readBranch("feature")).toBe(commitHash);
  });

  test("createBranch() 重复分支抛出异常", () => {
    const { ops } = createOps();
    ops.createBranch("feature", testHash);
    expect(() => ops.createBranch("feature", testHash)).toThrow("Branch already exists");
  });

  test("readBranch() 不存在的分支返回 null", () => {
    const { ops } = createOps();
    expect(ops.readBranch("nonexistent")).toBeNull();
  });

  test("listBranches() 列出所有分支", () => {
    const { ops, backend } = createOps();
    // 初始时 HEAD 指向 refs/heads/main 但该 ref 还不存在
    expect(ops.listBranches()).toEqual([]);

    // 创建 refs/heads/main 使 main 分支可见
    backend.refs.write("refs/heads/main", testHash);
    expect(ops.listBranches()).toEqual(["main"]);

    ops.createBranch("feature", testHash);
    ops.createBranch("develop", testHash);
    expect(ops.listBranches().sort()).toEqual(["develop", "feature", "main"]);
  });

  test("deleteBranch() 删除非当前分支", () => {
    const { ops, backend } = createOps();
    backend.refs.write("refs/heads/main", testHash);
    ops.createBranch("feature", testHash);
    ops.deleteBranch("feature");
    expect(ops.readBranch("feature")).toBeNull();
  });

  test("deleteBranch() 删除当前分支抛出异常", () => {
    const { ops, backend } = createOps();
    backend.refs.write("refs/heads/main", testHash);
    expect(() => ops.deleteBranch("main")).toThrow("Cannot delete current branch");
  });

  test("createTag() 创建轻量标签", () => {
    const { ops } = createOps();
    ops.createTag("v1.0", testHash);
    expect(ops.readTag("v1.0")).toBe(testHash);
  });

  test("createTag() 重复标签抛出异常", () => {
    const { ops } = createOps();
    ops.createTag("v1.0", testHash);
    expect(() => ops.createTag("v1.0", testHash)).toThrow("Tag already exists");
  });

  test("readTag() 不存在的标签返回 null", () => {
    const { ops } = createOps();
    expect(ops.readTag("nonexistent")).toBeNull();
  });

  test("listTags() 列出所有标签", () => {
    const { ops } = createOps();
    expect(ops.listTags()).toEqual([]);
    ops.createTag("v1.0", testHash);
    ops.createTag("v2.0", testHash);
    expect(ops.listTags().sort()).toEqual(["v1.0", "v2.0"]);
  });

  test("deleteTag() 删除标签", () => {
    const { ops } = createOps();
    ops.createTag("v1.0", testHash);
    ops.deleteTag("v1.0");
    expect(ops.readTag("v1.0")).toBeNull();
  });

  test("createAnnotatedTag() 创建附注标签", () => {
    const { ops, backend } = createOps();
    // 先写入一个对象作为标签目标
    const blob: import("@/core/types.ts").GitBlob = {
      type: "blob",
      content: Buffer.from("content"),
    };
    const target = writeObject(backend.objects, blob);

    const tagHash = ops.createAnnotatedTag("v1.0", target, "release note", testAuthor);
    expect(typeof tagHash).toBe("string");
    expect(tagHash).toMatch(/^[0-9a-f]{40}$/);

    // 验证引用指向了 tag 对象
    const refHash = ops.readTag("v1.0");
    expect(refHash).toBe(tagHash);

    // 验证 tag 对象内容
    const tag = readObject(backend.objects, tagHash);
    expect(tag.type).toBe("tag");
    if (tag.type === "tag") {
      expect(tag.tag).toBe("v1.0");
      expect(tag.object).toBe(target);
      expect(tag.message).toBe("release note");
    }
  });

  test("createAnnotatedTag() 重复标签抛出异常", () => {
    const { ops, backend } = createOps();
    const target = writeObject(backend.objects, { type: "blob", content: Buffer.from("c") });
    ops.createAnnotatedTag("v1.0", target, "msg", testAuthor);
    expect(() => ops.createAnnotatedTag("v1.0", target, "msg", testAuthor)).toThrow(
      "Tag already exists",
    );
  });
});
