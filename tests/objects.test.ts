/**
 * objects.ts 单元测试
 *
 * 测试 Git 对象的序列化/反序列化
 */

import { describe, test, expect } from "bun:test";
import {
  serialize,
  deserialize,
  serializeContent,
  deserializeContent,
} from "../src/objects/index.ts";
import { sha1 } from "../src/types.ts";
import type { GitBlob, GitTree, GitCommit, GitTag, GitAuthor } from "../src/types.ts";

// 测试用的作者信息
const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

// ============================================================================
// Blob 序列化/反序列化
// ============================================================================

describe("Blob 序列化", () => {
  test("序列化 blob 对象", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("hello"),
    };
    const serialized = serialize(blob);
    expect(serialized.toString("utf-8")).toBe("blob 5\0hello");
  });

  test("序列化空 blob", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from(""),
    };
    const serialized = serialize(blob);
    expect(serialized.toString("utf-8")).toBe("blob 0\0");
  });

  test("反序列化 blob 对象", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("hello world"),
    };
    const serialized = serialize(blob);
    const deserialized = deserialize(serialized);

    expect(deserialized.type).toBe("blob");
    if (deserialized.type === "blob") {
      expect(deserialized.content.toString("utf-8")).toBe("hello world");
    }
  });

  test("序列化/反序列化往返保持一致", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("测试中文内容"),
    };
    const deserialized = deserialize(serialize(blob));
    expect(deserialized.type).toBe("blob");
    if (deserialized.type === "blob") {
      expect(deserialized.content.toString("utf-8")).toBe("测试中文内容");
    }
  });
});

// ============================================================================
// Tree 序列化/反序列化
// ============================================================================

describe("Tree 序列化", () => {
  test("序列化包含单个条目的 tree", () => {
    const tree: GitTree = {
      type: "tree",
      entries: [
        {
          mode: "100644",
          name: "file.txt",
          hash: sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"),
        },
      ],
    };
    const serialized = serialize(tree);
    // 验证包含正确的 header
    expect(serialized.toString("utf-8").startsWith("tree ")).toBe(true);
    expect(serialized.includes("\0")).toBe(true);
  });

  test("序列化空 tree", () => {
    const tree: GitTree = {
      type: "tree",
      entries: [],
    };
    const serialized = serialize(tree);
    expect(serialized.toString("utf-8")).toBe("tree 0\0");
  });

  test("序列化/反序列化往返保持一致", () => {
    const tree: GitTree = {
      type: "tree",
      entries: [
        {
          mode: "100644",
          name: "file1.txt",
          hash: sha1("1111111111111111111111111111111111111111"),
        },
        {
          mode: "100755",
          name: "script.sh",
          hash: sha1("2222222222222222222222222222222222222222"),
        },
        {
          mode: "40000",
          name: "subdir",
          hash: sha1("3333333333333333333333333333333333333333"),
        },
      ],
    };

    const deserialized = deserialize(serialize(tree));
    expect(deserialized.type).toBe("tree");
    if (deserialized.type === "tree") {
      expect(deserialized.entries).toHaveLength(3);
      expect(deserialized.entries[0]).toEqual(tree.entries[0]);
      expect(deserialized.entries[1]).toEqual(tree.entries[1]);
      expect(deserialized.entries[2]).toEqual(tree.entries[2]);
    }
  });

  test("tree 条目中的哈希正确转换", () => {
    const hash = sha1("abcdef1234567890abcdef1234567890abcdef12");
    const tree: GitTree = {
      type: "tree",
      entries: [{ mode: "100644", name: "test.txt", hash }],
    };

    const deserialized = deserialize(serialize(tree));
    if (deserialized.type === "tree") {
      expect(deserialized.entries[0]!.hash).toBe(hash);
    }
  });
});

// ============================================================================
// Commit 序列化/反序列化
// ============================================================================

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

// ============================================================================
// Tag 序列化/反序列化
// ============================================================================

describe("Tag 序列化", () => {
  test("序列化/反序列化往返保持一致", () => {
    const tag: GitTag = {
      type: "tag",
      object: sha1("1111111111111111111111111111111111111111"),
      objectType: "commit",
      tag: "v1.0.0",
      tagger: testAuthor,
      message: "Release v1.0.0",
    };

    const deserialized = deserialize(serialize(tag));
    expect(deserialized.type).toBe("tag");
    if (deserialized.type === "tag") {
      expect(deserialized.object).toBe(tag.object);
      expect(deserialized.objectType).toBe("commit");
      expect(deserialized.tag).toBe("v1.0.0");
      expect(deserialized.tagger.name).toBe("Test User");
      expect(deserialized.message).toBe("Release v1.0.0");
    }
  });
});

// ============================================================================
// 错误处理
// ============================================================================

describe("反序列化错误处理", () => {
  test("缺少 null 字节应抛出异常", () => {
    const data = Buffer.from("invalid data without null byte");
    expect(() => deserialize(data)).toThrow("missing null byte");
  });

  test("无效的 header 格式应抛出异常", () => {
    const data = Buffer.from("invalid header\0content");
    expect(() => deserialize(data)).toThrow("Invalid Git object header");
  });

  test("大小不匹配应抛出异常", () => {
    const data = Buffer.from("blob 100\0short");
    expect(() => deserialize(data)).toThrow("Size mismatch");
  });
});

// ============================================================================
// serializeContent / deserializeContent
// ============================================================================

describe("serializeContent / deserializeContent", () => {
  test("blob 内容序列化", () => {
    const blob: GitBlob = {
      type: "blob",
      content: Buffer.from("test content"),
    };
    const content = serializeContent(blob);
    expect(content.toString("utf-8")).toBe("test content");
  });

  test("deserializeContent 正确解析 blob", () => {
    const content = Buffer.from("test content");
    const obj = deserializeContent("blob", content);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("test content");
    }
  });
});
