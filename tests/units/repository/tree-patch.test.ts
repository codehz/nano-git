/**
 * patchTree 增量 tree 操作测试
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";

import type { GitTree } from "@/core/types.ts";
import type { Repository } from "@/repository/types.ts";

describe("patchTree()", () => {
  let repo: Repository;

  beforeEach(() => {
    repo = createMemoryRepository();
  });

  test("upsert 新文件到根目录", () => {
    const rootHash = repo.createTree([]);
    const blobHash = repo.writeBlob(Buffer.from("content"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "file.txt", mode: "100644", hash: blobHash },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("file.txt");
      expect(tree.entries[0]!.mode).toBe("100644");
      expect(tree.entries[0]!.hash).toBe(blobHash);
    }
    expect(result.writtenTrees).toContain(result.rootHash);
  });

  test("upsert 符号链接", () => {
    const rootHash = repo.createTree([]);
    const targetHash = repo.writeBlob(Buffer.from("/usr/bin/node"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "node", mode: "120000", hash: targetHash },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("node");
      expect(tree.entries[0]!.mode).toBe("120000");
    }
  });

  test("upsert 到新子目录（自动创建中间目录）", () => {
    const rootHash = repo.createTree([]);
    const blobHash = repo.writeBlob(Buffer.from("nested content"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "a/b/c/file.txt", mode: "100644", hash: blobHash },
    ]);

    const root = repo.catFile(result.rootHash);
    expect(root.type).toBe("tree");
    if (root.type === "tree") {
      expect(root.entries).toHaveLength(1);
      expect(root.entries[0]!.name).toBe("a");
      expect(root.entries[0]!.mode).toBe("040000");
    }

    const aTree = repo.catFile((root as GitTree).entries.find((e) => e.name === "a")!.hash);
    expect(aTree.type).toBe("tree");
    if (aTree.type === "tree") {
      expect(aTree.entries).toHaveLength(1);
      expect(aTree.entries[0]!.name).toBe("b");
    }

    const bTree = repo.catFile((aTree as GitTree).entries.find((e) => e.name === "b")!.hash);
    expect(bTree.type).toBe("tree");
    if (bTree.type === "tree") {
      expect(bTree.entries).toHaveLength(1);
      expect(bTree.entries[0]!.name).toBe("c");
    }

    const cTree = repo.catFile((bTree as GitTree).entries.find((e) => e.name === "c")!.hash);
    expect(cTree.type).toBe("tree");
    if (cTree.type === "tree") {
      expect(cTree.entries).toHaveLength(1);
      expect(cTree.entries[0]!.name).toBe("file.txt");
      expect(cTree.entries[0]!.hash).toBe(blobHash);
    }
  });

  test("upsert 替换已有文件", () => {
    const oldHash = repo.writeBlob(Buffer.from("old"));
    const rootHash = repo.createTree([{ mode: "100644", name: "file.txt", hash: oldHash }]);
    const newHash = repo.writeBlob(Buffer.from("new"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "file.txt", mode: "100755", hash: newHash },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("file.txt");
      expect(tree.entries[0]!.mode).toBe("100755");
      expect(tree.entries[0]!.hash).toBe(newHash);
    }
  });

  test("upsert 替换子树中的文件", () => {
    const oldHash = repo.writeBlob(Buffer.from("old"));
    const subTreeHash = repo.createTree([{ mode: "100644", name: "old.txt", hash: oldHash }]);
    const rootHash = repo.createTree([{ mode: "040000", name: "sub", hash: subTreeHash }]);

    const newHash = repo.writeBlob(Buffer.from("new"));
    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "sub/old.txt", mode: "100644", hash: newHash },
    ]);

    const root = repo.catFile(result.rootHash);
    expect(root.type).toBe("tree");
    if (root.type === "tree") {
      expect(root.entries).toHaveLength(1);
      const sub = repo.catFile(root.entries[0]!.hash);
      expect(sub.type).toBe("tree");
      if (sub.type === "tree") {
        expect(sub.entries).toHaveLength(1);
        expect(sub.entries[0]!.hash).toBe(newHash);
      }
    }
  });

  test("delete 删除已有文件", () => {
    const blobHash = repo.writeBlob(Buffer.from("to-delete"));
    const rootHash = repo.createTree([
      { mode: "100644", name: "keep.txt", hash: repo.writeBlob(Buffer.from("keep")) },
      { mode: "100644", name: "delete.txt", hash: blobHash },
    ]);

    const result = repo.patchTree(rootHash, [{ op: "delete", path: "delete.txt" }]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("keep.txt");
    }
  });

  test("delete 不存在的路径应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "delete", path: "nonexistent.txt" }])).toThrow(
      "path does not exist",
    );
  });

  test("delete 支持删除目录条目", () => {
    const subHash = repo.createTree([
      { mode: "100644", name: "f.txt", hash: repo.writeBlob(Buffer.from("f")) },
    ]);
    const rootHash = repo.createTree([{ mode: "040000", name: "subdir", hash: subHash }]);

    const result = repo.patchTree(rootHash, [{ op: "delete", path: "subdir" }]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(0);
    }
  });

  test("delete 深层路径不存在的文件应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "delete", path: "a/b/c/file.txt" }])).toThrow(
      "path does not exist",
    );
  });

  test("同路径多次操作最后一个生效（最后是 upsert）", () => {
    const rootHash = repo.createTree([]);
    const hash1 = repo.writeBlob(Buffer.from("first"));
    const hash2 = repo.writeBlob(Buffer.from("second"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "f.txt", mode: "100644", hash: hash1 },
      { op: "delete", path: "f.txt" },
      { op: "upsert", path: "f.txt", mode: "100755", hash: hash2 },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.hash).toBe(hash2);
      expect(tree.entries[0]!.mode).toBe("100755");
    }
  });

  test("同路径多次操作最后一个生效（最后是 delete）", () => {
    const rootHash = repo.createTree([]);
    const hash = repo.writeBlob(Buffer.from("content"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "f.txt", mode: "100644", hash },
      { op: "delete", path: "f.txt" },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(0);
    }
  });

  test("同时在多个不同路径 upsert", () => {
    const rootHash = repo.createTree([]);
    const h1 = repo.writeBlob(Buffer.from("a"));
    const h2 = repo.writeBlob(Buffer.from("b"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "src/a.ts", mode: "100644", hash: h1 },
      { op: "upsert", path: "src/b.ts", mode: "100644", hash: h2 },
      { op: "upsert", path: "README.md", mode: "100644", hash: h1 },
    ]);

    const root = repo.catFile(result.rootHash);
    expect(root.type).toBe("tree");
    if (root.type === "tree") {
      expect(root.entries).toHaveLength(2);
      const srcEntry = root.entries.find((e) => e.name === "src")!;
      expect(srcEntry).toBeDefined();

      const src = repo.catFile(srcEntry.hash);
      expect(src.type).toBe("tree");
      if (src.type === "tree") {
        expect(src.entries).toHaveLength(2);
        expect(src.entries.find((e) => e.name === "a.ts")!.hash).toBe(h1);
        expect(src.entries.find((e) => e.name === "b.ts")!.hash).toBe(h2);
      }
    }
  });

  test("空操作列表返回原 tree", () => {
    const blobHash = repo.writeBlob(Buffer.from("content"));
    const rootHash = repo.createTree([{ mode: "100644", name: "f.txt", hash: blobHash }]);

    const result = repo.patchTree(rootHash, []);

    expect(result.rootHash).toBe(rootHash);
    expect(result.writtenTrees).toHaveLength(0);
  });

  test("writtenTrees 包含所有新写入的中间 tree", () => {
    const rootHash = repo.createTree([]);
    const blobHash = repo.writeBlob(Buffer.from("deep"));

    const result = repo.patchTree(rootHash, [
      { op: "upsert", path: "x/y/z.txt", mode: "100644", hash: blobHash },
    ]);

    expect(result.writtenTrees.length).toBeGreaterThanOrEqual(3);
    expect(result.writtenTrees).toContain(result.rootHash);
  });

  test("路径格式校验：空路径应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "delete", path: "" }])).toThrow(
      "Path must not be empty",
    );
  });

  test("路径格式校验：以斜杠开头应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "delete", path: "/file.txt" }])).toThrow(
      "Path must not start with '/'",
    );
  });

  test("路径格式校验：以斜杠结尾应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "delete", path: "dir/" }])).toThrow(
      "Path must not end with '/'",
    );
  });

  test("路径格式校验：包含 .. 应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "delete", path: "../escape" }])).toThrow(
      "Path must not contain '.' or '..'",
    );
  });

  // ---- rename 操作 ----

  test("rename 文件在同层目录", () => {
    const hash = repo.writeBlob(Buffer.from("content"));
    const rootHash = repo.createTree([{ mode: "100644", name: "old.txt", hash }]);

    const result = repo.patchTree(rootHash, [{ op: "rename", from: "old.txt", to: "new.txt" }]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("new.txt");
      expect(tree.entries[0]!.hash).toBe(hash);
      expect(tree.entries[0]!.mode).toBe("100644");
    }
  });

  test("rename 符号链接", () => {
    const targetHash = repo.writeBlob(Buffer.from("/usr/bin/node"));
    const rootHash = repo.createTree([{ mode: "120000", name: "old-link", hash: targetHash }]);

    const result = repo.patchTree(rootHash, [{ op: "rename", from: "old-link", to: "new-link" }]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("new-link");
      expect(tree.entries[0]!.mode).toBe("120000");
      expect(tree.entries[0]!.hash).toBe(targetHash);
    }
  });

  test("rename 目录（子树平移，tree hash 不变）", () => {
    const subHash = repo.createTree([
      { mode: "100644", name: "a.txt", hash: repo.writeBlob(Buffer.from("a")) },
    ]);
    const rootHash = repo.createTree([{ mode: "040000", name: "src", hash: subHash }]);

    const result = repo.patchTree(rootHash, [{ op: "rename", from: "src", to: "lib" }]);

    const root = repo.catFile(result.rootHash);
    expect(root.type).toBe("tree");
    if (root.type === "tree") {
      expect(root.entries).toHaveLength(1);
      expect(root.entries[0]!.name).toBe("lib");
      expect(root.entries[0]!.mode).toBe("040000");
      expect(root.entries[0]!.hash).toBe(subHash);
    }
  });

  test("rename 跨目录移动文件", () => {
    const hash = repo.writeBlob(Buffer.from("content"));
    const subHash = repo.createTree([]);
    const rootHash = repo.createTree([
      { mode: "100644", name: "file.txt", hash },
      { mode: "040000", name: "subdir", hash: subHash },
    ]);

    const result = repo.patchTree(rootHash, [
      { op: "rename", from: "file.txt", to: "subdir/file.txt" },
    ]);

    const root = repo.catFile(result.rootHash);
    expect(root.type).toBe("tree");
    if (root.type === "tree") {
      expect(root.entries).toHaveLength(1);
      const sub = repo.catFile(root.entries[0]!.hash);
      expect(sub.type).toBe("tree");
      if (sub.type === "tree") {
        expect(sub.entries).toHaveLength(1);
        expect(sub.entries[0]!.name).toBe("file.txt");
        expect(sub.entries[0]!.hash).toBe(hash);
      }
    }
  });

  test("rename 跨目录且自动创建中间目录", () => {
    const hash = repo.writeBlob(Buffer.from("nested"));
    const rootHash = repo.createTree([{ mode: "100644", name: "old.txt", hash }]);

    const result = repo.patchTree(rootHash, [
      { op: "rename", from: "old.txt", to: "a/b/c/new.txt" },
    ]);

    const root = repo.catFile(result.rootHash);
    expect(root.type).toBe("tree");
    if (root.type === "tree") {
      expect(root.entries).toHaveLength(1);
      expect(root.entries[0]!.name).toBe("a");
    }
  });

  test("rename 到已存在的路径（覆盖）", () => {
    const oldHash = repo.writeBlob(Buffer.from("old"));
    const newHash = repo.writeBlob(Buffer.from("new"));
    const rootHash = repo.createTree([
      { mode: "100644", name: "src", hash: oldHash },
      { mode: "100644", name: "dst", hash: newHash },
    ]);

    const result = repo.patchTree(rootHash, [{ op: "rename", from: "src", to: "dst" }]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("dst");
      expect(tree.entries[0]!.hash).toBe(oldHash);
    }
  });

  test("rename from 不存在应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() =>
      repo.patchTree(rootHash, [{ op: "rename", from: "nonexistent", to: "new" }]),
    ).toThrow("path does not exist");
  });

  test("rename 深层路径 from 不存在应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() =>
      repo.patchTree(rootHash, [{ op: "rename", from: "a/b/c.txt", to: "d/e.txt" }]),
    ).toThrow("path does not exist");
  });

  test("rename from === to 为 no-op", () => {
    const hash = repo.writeBlob(Buffer.from("content"));
    const rootHash = repo.createTree([{ mode: "100644", name: "f.txt", hash }]);

    const result = repo.patchTree(rootHash, [{ op: "rename", from: "f.txt", to: "f.txt" }]);

    expect(result.rootHash).toBe(rootHash);
    expect(result.writtenTrees).toHaveLength(0);
  });

  test("rename 链式操作：a → b → c", () => {
    const hash = repo.writeBlob(Buffer.from("content"));
    const rootHash = repo.createTree([{ mode: "100644", name: "a", hash }]);

    const result = repo.patchTree(rootHash, [
      { op: "rename", from: "a", to: "b" },
      { op: "rename", from: "b", to: "c" },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("c");
      expect(tree.entries[0]!.hash).toBe(hash);
    }
  });

  test("rename 与 upsert 交错执行", () => {
    const hash1 = repo.writeBlob(Buffer.from("first"));
    const hash2 = repo.writeBlob(Buffer.from("second"));
    const rootHash = repo.createTree([{ mode: "100644", name: "a", hash: hash1 }]);

    const result = repo.patchTree(rootHash, [
      { op: "rename", from: "a", to: "b" },
      { op: "upsert", path: "a", mode: "100644", hash: hash2 },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(2);
      expect(tree.entries.find((e) => e.name === "a")!.hash).toBe(hash2);
      expect(tree.entries.find((e) => e.name === "b")!.hash).toBe(hash1);
    }
  });

  test("rename 与 delete 交错执行", () => {
    const hash = repo.writeBlob(Buffer.from("content"));
    const rootHash = repo.createTree([
      { mode: "100644", name: "a", hash },
      { mode: "100644", name: "b", hash },
    ]);

    const result = repo.patchTree(rootHash, [
      { op: "delete", path: "a" },
      { op: "rename", from: "b", to: "a" },
    ]);

    const tree = repo.catFile(result.rootHash);
    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]!.name).toBe("a");
      expect(tree.entries[0]!.hash).toBe(hash);
    }
  });

  test("rename 路径格式校验：空 from/to 应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "rename", from: "", to: "new" }])).toThrow(
      "Path must not be empty",
    );
    expect(() => repo.patchTree(rootHash, [{ op: "rename", from: "old", to: "" }])).toThrow(
      "Path must not be empty",
    );
  });

  test("rename 路径格式校验：包含 .. 应抛出异常", () => {
    const rootHash = repo.createTree([]);
    expect(() => repo.patchTree(rootHash, [{ op: "rename", from: "../old", to: "new" }])).toThrow(
      "Path must not contain '.' or '..'",
    );
    expect(() => repo.patchTree(rootHash, [{ op: "rename", from: "old", to: "../new" }])).toThrow(
      "Path must not contain '.' or '..'",
    );
  });
});
