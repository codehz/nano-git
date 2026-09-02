/**
 * Git Tree 对象序列化/反序列化测试
 */

import { describe, test, expect } from "bun:test";

import { bytesToUtf8 } from "../../helpers/bytes.ts";
import {
  serialize,
  deserialize,
  compareTreeEntries,
  sortTreeEntries,
  treeEntrySortKey,
} from "@/objects/index.ts";
import { sha1 } from "@/types/index.ts";

import type { GitTree, TreeEntry } from "@/types/index.ts";

const H1 = sha1("1111111111111111111111111111111111111111");
const H2 = sha1("2222222222222222222222222222222222222222");
const H3 = sha1("3333333333333333333333333333333333333333");
const H4 = sha1("4444444444444444444444444444444444444444");

describe("Tree 排序", () => {
  test("目录排序键追加斜杠", () => {
    expect(treeEntrySortKey({ mode: "040000", name: "foo" })).toBe("foo/");
    expect(treeEntrySortKey({ mode: "40000", name: "foo" })).toBe("foo/");
    expect(treeEntrySortKey({ mode: "100644", name: "foo.txt" })).toBe("foo.txt");
  });

  test("foo.txt 排在目录 foo 之前（'.' < '/'）", () => {
    expect(
      compareTreeEntries({ mode: "100644", name: "foo.txt" }, { mode: "040000", name: "foo" }),
    ).toBeLessThan(0);
  });

  test("bodies 目录排在 outline.json 之前", () => {
    expect(
      compareTreeEntries(
        { mode: "040000", name: "bodies" },
        { mode: "100644", name: "outline.json" },
      ),
    ).toBeLessThan(0);
  });

  test("字节序：大写 B 排在小写 a 之前（不能用 localeCompare）", () => {
    expect(
      compareTreeEntries(
        { mode: "100644", name: "res_Bxo.txt" },
        { mode: "100644", name: "res_aso.txt" },
      ),
    ).toBeLessThan(0);
  });

  test("sortTreeEntries 产出 Git 规范顺序", () => {
    const sorted = sortTreeEntries([
      { mode: "100644", name: "outline.json", hash: H1 },
      { mode: "100644", name: "res_aso.txt", hash: H2 },
      { mode: "040000", name: "foo", hash: H3 },
      { mode: "100644", name: "foo.txt", hash: H4 },
      { mode: "040000", name: "bodies", hash: H1 },
      { mode: "100644", name: "res_Bxo.txt", hash: H2 },
    ]);

    expect(sorted.map((e) => e.name)).toEqual([
      "bodies",
      "foo.txt",
      "foo",
      "outline.json",
      "res_Bxo.txt",
      "res_aso.txt",
    ]);
  });
});

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
    expect(bytesToUtf8(serialized).startsWith("tree ")).toBe(true);
    expect(bytesToUtf8(serialized).includes("\0")).toBe(true);
  });

  test("序列化空 tree", () => {
    const tree: GitTree = {
      type: "tree",
      entries: [],
    };
    const serialized = serialize(tree);
    expect(bytesToUtf8(serialized)).toBe("tree 0\0");
  });

  test("序列化时自动按 Git 规范重排条目", () => {
    const tree: GitTree = {
      type: "tree",
      entries: [
        { mode: "100644", name: "outline.json", hash: H1 },
        { mode: "040000", name: "bodies", hash: H2 },
        { mode: "100644", name: "foo.txt", hash: H3 },
        { mode: "040000", name: "foo", hash: H4 },
      ],
    };

    const deserialized = deserialize(serialize(tree));
    expect(deserialized.type).toBe("tree");
    if (deserialized.type === "tree") {
      expect(deserialized.entries.map((e: TreeEntry) => e.name)).toEqual([
        "bodies",
        "foo.txt",
        "foo",
        "outline.json",
      ]);
    }
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
          mode: "040000",
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
