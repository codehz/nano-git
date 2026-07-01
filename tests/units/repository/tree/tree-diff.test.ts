/**
 * repository/tree/tree-diff.ts 单元测试
 */

import { describe, test, expect } from "bun:test";

import { writeObject } from "@/objects/raw.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { diffTrees, readTree, readTreeSnapshot, walkTree } from "@/repository/tree/tree-diff.ts";
import { sha1 } from "@/types/index.ts";

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

    expect(paths).toEqual(["a.txt", "dir", "dir/inner.txt", "b.txt"]);
  });
});

describe("readTreeSnapshot()", () => {
  test("返回包含目录条目的完整快照", () => {
    const repo = createMemoryRepository();
    const fileHash = repo.writeBlob(Buffer.from("hello"));
    const nestedTree = repo.createTree([{ mode: "100644", name: "main.ts", hash: fileHash }]);
    const rootTree = repo.createTree([{ mode: "040000", name: "src", hash: nestedTree }]);

    expect(readTreeSnapshot(repo.objects, rootTree)).toEqual([
      {
        path: "src",
        object: {
          kind: "tree",
          mode: "040000",
          hash: nestedTree,
        },
      },
      {
        path: "src/main.ts",
        object: {
          kind: "blob",
          mode: "100644",
          hash: fileHash,
        },
      },
    ]);
  });
});

describe("diffTrees()", () => {
  test("支持 create / remove / update 混合 diff", () => {
    const repo = createMemoryRepository();
    const beforeReadme = repo.writeBlob(Buffer.from("before"));
    const afterReadme = repo.writeBlob(Buffer.from("after"));
    const removedBlob = repo.writeBlob(Buffer.from("old"));
    const keptBlob = repo.writeBlob(Buffer.from("same"));
    const addedBlob = repo.writeBlob(Buffer.from("new"));
    const oldDir = repo.createTree([{ mode: "100644", name: "keep.txt", hash: keptBlob }]);
    const newDir = repo.createTree([{ mode: "100644", name: "keep.txt", hash: keptBlob }]);

    const previousTree = repo.createTree([
      { mode: "100644", name: "README.md", hash: beforeReadme },
      { mode: "100644", name: "obsolete.txt", hash: removedBlob },
      { mode: "040000", name: "docs", hash: oldDir },
    ]);
    const currentTree = repo.createTree([
      { mode: "100644", name: "README.md", hash: afterReadme },
      { mode: "100644", name: "added.txt", hash: addedBlob },
      { mode: "040000", name: "guides", hash: newDir },
    ]);

    expect(diffTrees(repo.objects, previousTree, currentTree)).toEqual([
      {
        kind: "create",
        path: "added.txt",
        current: {
          kind: "blob",
          mode: "100644",
          hash: addedBlob,
        },
      },
      {
        kind: "remove",
        path: "docs",
        previous: {
          kind: "tree",
          mode: "040000",
          hash: oldDir,
        },
      },
      {
        kind: "remove",
        path: "docs/keep.txt",
        previous: {
          kind: "blob",
          mode: "100644",
          hash: keptBlob,
        },
      },
      {
        kind: "create",
        path: "guides",
        current: {
          kind: "tree",
          mode: "040000",
          hash: newDir,
        },
      },
      {
        kind: "create",
        path: "guides/keep.txt",
        current: {
          kind: "blob",
          mode: "100644",
          hash: keptBlob,
        },
      },
      {
        kind: "remove",
        path: "obsolete.txt",
        previous: {
          kind: "blob",
          mode: "100644",
          hash: removedBlob,
        },
      },
      {
        kind: "update",
        path: "README.md",
        previous: {
          kind: "blob",
          mode: "100644",
          hash: beforeReadme,
        },
        current: {
          kind: "blob",
          mode: "100644",
          hash: afterReadme,
        },
        changes: {
          kindChanged: false,
          modeChanged: false,
          contentChanged: true,
        },
      },
    ]);
  });

  test("同路径 mode 变化输出 update", () => {
    const repo = createMemoryRepository();
    const blob = repo.writeBlob(Buffer.from("same"));
    const previousTree = repo.createTree([{ mode: "100644", name: "run", hash: blob }]);
    const currentTree = repo.createTree([{ mode: "100755", name: "run", hash: blob }]);

    expect(diffTrees(repo.objects, previousTree, currentTree)).toEqual([
      {
        kind: "update",
        path: "run",
        previous: {
          kind: "blob",
          mode: "100644",
          hash: blob,
        },
        current: {
          kind: "blob",
          mode: "100755",
          hash: blob,
        },
        changes: {
          kindChanged: false,
          modeChanged: true,
          contentChanged: false,
        },
      },
    ]);
  });

  test("相同 tree diff 为空", () => {
    const repo = createMemoryRepository();
    const fileHash = repo.writeBlob(Buffer.from("same"));
    const tree = repo.createTree([{ mode: "100644", name: "same.txt", hash: fileHash }]);

    expect(diffTrees(repo.objects, tree, tree)).toEqual([]);
  });
});
