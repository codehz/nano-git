/**
 * Git Tree 对象序列化/反序列化测试
 */

import { describe, test, expect } from "bun:test";

import { sha1 } from "../../../src/core/types.ts";
import { serialize, deserialize } from "../../../src/objects/index.ts";

import type { GitTree } from "../../../src/core/types.ts";

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
