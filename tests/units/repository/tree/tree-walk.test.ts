/**
 * repository/tree/tree-walk.ts 单元测试
 */

import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import { writeObject } from "@/objects/raw.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";
import { readTree, walkTree } from "@/repository/tree/tree-walk.ts";

const fileHash = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");

describe("readTree()", () => {
  test("空 tree 返回空数组", () => {
    const store = createMemoryObjectStore();
    const treeHash = writeObject(store, { type: "tree", entries: [] });

    const entries = readTree(store, treeHash);
    expect(entries).toEqual([]);
  });

  test("展平单层 tree", () => {
    const store = createMemoryObjectStore();
    const treeHash = writeObject(store, {
      type: "tree",
      entries: [
        { mode: "100644", name: "a.txt", hash: fileHash },
        { mode: "100755", name: "b.sh", hash: fileHash },
      ],
    });

    const entries = readTree(store, treeHash);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.path).toBe("a.txt");
    expect(entries[0]!.mode).toBe("100644");
    expect(entries[1]!.path).toBe("b.sh");
    expect(entries[1]!.mode).toBe("100755");
  });

  test("递归展平嵌套 tree（包含目录条目）", () => {
    const store = createMemoryObjectStore();
    const subTreeHash = writeObject(store, {
      type: "tree",
      entries: [{ mode: "100644", name: "inner.txt", hash: fileHash }],
    });
    const rootHash = writeObject(store, {
      type: "tree",
      entries: [
        { mode: "100644", name: "root.txt", hash: fileHash },
        { mode: "040000", name: "subdir", hash: subTreeHash },
      ],
    });

    const entries = readTree(store, rootHash);
    // 遍历包含目录条目自身，深度优先：root.txt, subdir, subdir/inner.txt
    expect(entries).toHaveLength(3);
    expect(entries[0]!.path).toBe("root.txt");
    expect(entries[1]!.path).toBe("subdir");
    expect(entries[1]!.mode).toBe("040000");
    expect(entries[2]!.path).toBe("subdir/inner.txt");
  });

  test("深层嵌套", () => {
    const store = createMemoryObjectStore();
    const level3 = writeObject(store, {
      type: "tree",
      entries: [{ mode: "100644", name: "deep.txt", hash: fileHash }],
    });
    const level2 = writeObject(store, {
      type: "tree",
      entries: [{ mode: "040000", name: "level3", hash: level3 }],
    });
    const level1 = writeObject(store, {
      type: "tree",
      entries: [{ mode: "040000", name: "level2", hash: level2 }],
    });

    const entries = readTree(store, level1);
    // 深度优先遍历包含所有目录条目
    expect(entries).toHaveLength(3);
    expect(entries[0]!.path).toBe("level2");
    expect(entries[1]!.path).toBe("level2/level3");
    expect(entries[2]!.path).toBe("level2/level3/deep.txt");
  });
});

describe("walkTree()", () => {
  test("对每个条目调用回调", () => {
    const store = createMemoryObjectStore();
    const treeHash = writeObject(store, {
      type: "tree",
      entries: [
        { mode: "100644", name: "a.txt", hash: fileHash },
        { mode: "100644", name: "b.txt", hash: fileHash },
      ],
    });

    const paths: string[] = [];
    walkTree(store, treeHash, (entry) => {
      paths.push(entry.path);
    });

    expect(paths).toEqual(["a.txt", "b.txt"]);
  });

  test("空 tree 不调用回调", () => {
    const store = createMemoryObjectStore();
    const treeHash = writeObject(store, { type: "tree", entries: [] });

    const fn = () => {};
    walkTree(store, treeHash, fn);
    // 不抛出异常即可
  });

  test("递归遍历顺序（深度优先）", () => {
    const store = createMemoryObjectStore();
    const subHash = writeObject(store, {
      type: "tree",
      entries: [{ mode: "100644", name: "inner.txt", hash: fileHash }],
    });
    const rootHash = writeObject(store, {
      type: "tree",
      entries: [
        { mode: "100644", name: "a.txt", hash: fileHash },
        { mode: "040000", name: "dir", hash: subHash },
        { mode: "100644", name: "b.txt", hash: fileHash },
      ],
    });

    const paths: string[] = [];
    walkTree(store, rootHash, (entry) => {
      paths.push(entry.path);
    });

    // walkTree 包含目录条目，深度优先：a.txt → dir → dir/inner.txt → b.txt
    expect(paths).toEqual(["a.txt", "dir", "dir/inner.txt", "b.txt"]);
  });
});
