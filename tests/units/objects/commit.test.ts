/**
 * Git Commit 对象序列化/反序列化测试
 */

import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import { serialize, deserialize } from "@/objects/index.ts";

import type { GitCommit, GitAuthor } from "@/core/types.ts";

const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

describe("Commit 序列化", () => {
  test("序列化无父节点的 commit", () => {
    const commit: GitCommit = {
      type: "commit",
      tree: sha1("1111111111111111111111111111111111111111"),
      parents: [],
      author: testAuthor,
      committer: testAuthor,
      message: "Initial commit",
    };

    const serialized = serialize(commit);
    const text = serialized.toString("utf-8");

    expect(text).toContain("tree 1111111111111111111111111111111111111111");
    expect(text).toContain("author Test User <test@example.com>");
    expect(text).toContain("committer Test User <test@example.com>");
    expect(text).toContain("Initial commit");
    expect(text).not.toContain("parent");
  });

  test("序列化有父节点的 commit", () => {
    const commit: GitCommit = {
      type: "commit",
      tree: sha1("1111111111111111111111111111111111111111"),
      parents: [sha1("2222222222222222222222222222222222222222")],
      author: testAuthor,
      committer: testAuthor,
      message: "Second commit",
    };

    const serialized = serialize(commit);
    const text = serialized.toString("utf-8");
    expect(text).toContain("parent 2222222222222222222222222222222222222222");
  });

  test("序列化 merge commit（多个父节点）", () => {
    const commit: GitCommit = {
      type: "commit",
      tree: sha1("1111111111111111111111111111111111111111"),
      parents: [
        sha1("2222222222222222222222222222222222222222"),
        sha1("3333333333333333333333333333333333333333"),
      ],
      author: testAuthor,
      committer: testAuthor,
      message: "Merge branch",
    };

    const serialized = serialize(commit);
    const text = serialized.toString("utf-8");
    expect(text).toContain("parent 2222222222222222222222222222222222222222");
    expect(text).toContain("parent 3333333333333333333333333333333333333333");
  });

  test("序列化/反序列化往返保持一致", () => {
    const commit: GitCommit = {
      type: "commit",
      tree: sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      parents: [sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")],
      author: {
        name: "Author Name",
        email: "author@example.com",
        timestamp: 1600000000,
        timezone: "+0000",
      },
      committer: {
        name: "Committer Name",
        email: "committer@example.com",
        timestamp: 1600000001,
        timezone: "-0500",
      },
      message: "Test commit message\n\nWith body",
    };

    const deserialized = deserialize(serialize(commit));
    expect(deserialized.type).toBe("commit");
    if (deserialized.type === "commit") {
      expect(deserialized.tree).toBe(commit.tree);
      expect(deserialized.parents).toEqual(commit.parents);
      expect(deserialized.author.name).toBe("Author Name");
      expect(deserialized.author.email).toBe("author@example.com");
      expect(deserialized.author.timestamp).toBe(1600000000);
      expect(deserialized.author.timezone).toBe("+0000");
      expect(deserialized.committer.name).toBe("Committer Name");
      expect(deserialized.message).toBe("Test commit message\n\nWith body");
    }
  });
});
