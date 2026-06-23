/**
 * 文件系统仓库对象操作测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashToPath } from "@/core/hash.ts";
import { createPackBuilder } from "@/odb/pack/index.ts";
import { initRepository, openRepository, type Repository } from "@/repository/index.ts";

import type { GitAuthor, TreeEntry } from "@/core/types.ts";

const testAuthor: GitAuthor = {
  name: "Test User",
  email: "test@example.com",
  timestamp: 1700000000,
  timezone: "+0800",
};

describe("文件系统仓库的对象操作", () => {
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

  test("writeBlob() 和 catFile() 配合工作", () => {
    const hash = repo.writeBlob(Buffer.from("test content"));
    const obj = repo.catFile(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("test content");
    }
  });

  test("writeBlobFile() 写入文件内容", () => {
    const filePath = join(tempDir, "test.txt");
    writeFileSync(filePath, "file content");
    const hash = repo.writeBlobFile(filePath);

    const obj = repo.catFile(hash);
    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("file content");
    }
  });

  test("writeTree() 将目录写入 tree 对象", () => {
    writeFileSync(join(tempDir, "file1.txt"), "content1");
    writeFileSync(join(tempDir, "file2.txt"), "content2");

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      const names = tree.entries.map((e: TreeEntry) => e.name);
      expect(names).toContain("file1.txt");
      expect(names).toContain("file2.txt");
      expect(names).not.toContain(".git");
    }
  });

  test("writeTree() 递归处理子目录", () => {
    writeFileSync(join(tempDir, "root.txt"), "root");
    mkdirSync(join(tempDir, "subdir"));
    writeFileSync(join(tempDir, "subdir", "nested.txt"), "nested");

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      const subdirEntry = tree.entries.find((e: TreeEntry) => e.name === "subdir");
      expect(subdirEntry).toBeDefined();
      expect(subdirEntry!.mode).toBe("40000");

      const subtree = repo.catFile(subdirEntry!.hash);
      expect(subtree.type).toBe("tree");
      if (subtree.type === "tree") {
        expect(subtree.entries).toHaveLength(1);
        expect(subtree.entries[0]!.name).toBe("nested.txt");
      }
    }
  });

  test("writeTree() 处理符号链接，使用 120000 mode", () => {
    const target = "/usr/bin/node";
    symlinkSync(target, join(tempDir, "node-link"));

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      const linkEntry = tree.entries.find((e: TreeEntry) => e.name === "node-link");
      expect(linkEntry).toBeDefined();
      expect(linkEntry!.mode).toBe("120000");

      const blob = repo.catFile(linkEntry!.hash);
      expect(blob.type).toBe("blob");
      if (blob.type === "blob") {
        expect(blob.content.toString("utf-8")).toBe(target);
      }
    }
  });

  test("writeTree() 处理相对路径符号链接", () => {
    symlinkSync("./relative-target.txt", join(tempDir, "rel-link"));

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      const linkEntry = tree.entries.find((e: TreeEntry) => e.name === "rel-link");
      expect(linkEntry).toBeDefined();
      expect(linkEntry!.mode).toBe("120000");

      const blob = repo.catFile(linkEntry!.hash);
      expect(blob.type).toBe("blob");
      if (blob.type === "blob") {
        expect(blob.content.toString("utf-8")).toBe("./relative-target.txt");
      }
    }
  });

  test("writeTree() 将符号链接到目录记录为 120000 而非递归遍历", () => {
    mkdirSync(join(tempDir, "real-dir"));
    writeFileSync(join(tempDir, "real-dir", "nested.txt"), "nested");
    symlinkSync("real-dir", join(tempDir, "link-to-dir"));

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      const linkEntry = tree.entries.find((e: TreeEntry) => e.name === "link-to-dir");
      expect(linkEntry).toBeDefined();
      expect(linkEntry!.mode).toBe("120000");

      const blob = repo.catFile(linkEntry!.hash);
      expect(blob.type).toBe("blob");
      if (blob.type === "blob") {
        expect(blob.content.toString("utf-8")).toBe("real-dir");
      }

      const dirEntry = tree.entries.find((e: TreeEntry) => e.name === "real-dir");
      expect(dirEntry).toBeDefined();
      expect(dirEntry!.mode).toBe("40000");
    }
  });

  test("writeTree() 处理断链符号链接（目标不存在）", () => {
    symlinkSync("/nonexistent/path", join(tempDir, "broken-link"));

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      const linkEntry = tree.entries.find((e: TreeEntry) => e.name === "broken-link");
      expect(linkEntry).toBeDefined();
      expect(linkEntry!.mode).toBe("120000");

      const blob = repo.catFile(linkEntry!.hash);
      expect(blob.type).toBe("blob");
      if (blob.type === "blob") {
        expect(blob.content.toString("utf-8")).toBe("/nonexistent/path");
      }
    }
  });

  test("writeTree() 处理子目录中的符号链接", () => {
    mkdirSync(join(tempDir, "sub"));
    symlinkSync("/any/target", join(tempDir, "sub", "inner-link"));
    writeFileSync(join(tempDir, "sub", "regular.txt"), "normal");

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      const subEntry = tree.entries.find((e: TreeEntry) => e.name === "sub");
      expect(subEntry).toBeDefined();
      expect(subEntry!.mode).toBe("40000");

      const subtree = repo.catFile(subEntry!.hash);
      expect(subtree.type).toBe("tree");
      if (subtree.type === "tree") {
        expect(subtree.entries).toHaveLength(2);

        const linkEntry = subtree.entries.find((e: TreeEntry) => e.name === "inner-link");
        expect(linkEntry).toBeDefined();
        expect(linkEntry!.mode).toBe("120000");

        const blob = repo.catFile(linkEntry!.hash);
        expect(blob.type).toBe("blob");
        if (blob.type === "blob") {
          expect(blob.content.toString("utf-8")).toBe("/any/target");
        }

        const regularEntry = subtree.entries.find((e: TreeEntry) => e.name === "regular.txt");
        expect(regularEntry).toBeDefined();
        expect(regularEntry!.mode).toBe("100644");
      }
    }
  });

  test("writeTree() 混合处理文件、可执行文件和符号链接", () => {
    writeFileSync(join(tempDir, "readme.md"), "docs");
    const execPath = join(tempDir, "run.sh");
    writeFileSync(execPath, "#!/bin/sh\necho hi");
    chmodSync(execPath, 0o755);
    symlinkSync("readme.md", join(tempDir, "doc-link"));

    const treeHash = repo.writeTree(tempDir);
    const tree = repo.catFile(treeHash);

    expect(tree.type).toBe("tree");
    if (tree.type === "tree") {
      expect(tree.entries).toHaveLength(3);

      const fileEntry = tree.entries.find((e: TreeEntry) => e.name === "readme.md");
      expect(fileEntry).toBeDefined();
      expect(fileEntry!.mode).toBe("100644");

      const execEntry = tree.entries.find((e: TreeEntry) => e.name === "run.sh");
      expect(execEntry).toBeDefined();
      expect(execEntry!.mode).toBe("100755");

      const linkEntry = tree.entries.find((e: TreeEntry) => e.name === "doc-link");
      expect(linkEntry).toBeDefined();
      expect(linkEntry!.mode).toBe("120000");
    }
  });

  test("openRepository() 默认可读取 packfile 中的对象", () => {
    const gitDir = join(tempDir, ".git");
    const builder = createPackBuilder(gitDir);
    const hash = builder.addObject({
      type: "blob",
      content: Buffer.from("packed-only content"),
    });
    builder.build();

    const packedRepo = openRepository(tempDir);
    const obj = packedRepo.catFile(hash);

    expect(obj.type).toBe("blob");
    if (obj.type === "blob") {
      expect(obj.content.toString("utf-8")).toBe("packed-only content");
    }
  });

  test("listObjects() 同时返回 loose 和 packed objects", () => {
    const gitDir = join(tempDir, ".git");
    const looseHash = repo.writeBlob(Buffer.from("loose"));

    const builder = createPackBuilder(gitDir);
    const packedHash = builder.addObject({
      type: "blob",
      content: Buffer.from("packed"),
    });
    builder.build();

    expect(repo.listObjects()).toContain(looseHash);
    expect(repo.listObjects()).toContain(packedHash);
  });

  test("writePack() 将对象写入新的 packfile", () => {
    const hash = repo.writeBlob(Buffer.from("pack me"));
    const result = repo.writePack([hash]);

    expect(result.objectCount).toBe(1);
    expect(existsSync(result.packPath)).toBe(true);
    expect(existsSync(result.idxPath)).toBe(true);
    expect(repo.packs!.source.packCount).toBe(1);

    const reopened = openRepository(tempDir);
    const obj = reopened.catFile(hash);
    expect(obj.type).toBe("blob");
  });

  test("repack() 默认替换旧 pack 文件", () => {
    repo.writeBlob(Buffer.from("first"));
    repo.writePack();

    repo.writeBlob(Buffer.from("second"));
    const result = repo.repack();

    expect(repo.packs!.source.packCount).toBe(1);
    expect(repo.packs!.source.listPacks()).toHaveLength(1);
    expect(repo.packs!.source.listPacks()[0]!.checksum).toBe(result.checksum);
  });

  test("repack({ pruneLoose: true }) 会删除已打包的 loose object 文件", () => {
    const gitDir = join(tempDir, ".git");
    const hash = repo.writeBlob(Buffer.from("packed and pruned"));
    const objectPath = join(gitDir, "objects", hashToPath(hash));

    expect(existsSync(objectPath)).toBe(true);

    repo.repack({ pruneLoose: true });

    expect(existsSync(objectPath)).toBe(false);
    const obj = repo.catFile(hash);
    expect(obj.type).toBe("blob");
  });

  test("listReachableObjects() 只返回从 refs/HEAD 可达的对象", () => {
    const reachableBlob = repo.writeBlob(Buffer.from("reachable"));
    const reachableTree = repo.createTree([
      { mode: "100644", name: "file.txt", hash: reachableBlob },
    ]);
    const reachableCommit = repo.createCommit(reachableTree, [], "reachable", testAuthor);
    repo.updateRef("refs/heads/main", reachableCommit);

    const unreachableBlob = repo.writeBlob(Buffer.from("unreachable"));
    const reachable = repo.listReachableObjects();

    expect(reachable).toContain(reachableBlob);
    expect(reachable).toContain(reachableTree);
    expect(reachable).toContain(reachableCommit);
    expect(reachable).not.toContain(unreachableBlob);
  });

  test("listReachableObjects() 会跟随 annotated tag", () => {
    const blobHash = repo.writeBlob(Buffer.from("tag target"));
    const tagHash = repo.createAnnotatedTag("v1.0.0", blobHash, "release", testAuthor, "blob");

    const reachable = repo.listReachableObjects();
    expect(reachable).toContain(tagHash);
    expect(reachable).toContain(blobHash);
  });

  test("gc() 只保留可达对象", () => {
    const gitDir = join(tempDir, ".git");
    const reachableBlob = repo.writeBlob(Buffer.from("reachable after gc"));
    const reachableTree = repo.createTree([
      { mode: "100644", name: "keep.txt", hash: reachableBlob },
    ]);
    const reachableCommit = repo.createCommit(reachableTree, [], "keep", testAuthor);
    repo.updateRef("refs/heads/main", reachableCommit);

    const danglingBlob = repo.writeBlob(Buffer.from("dangling"));
    const danglingPath = join(gitDir, "objects", hashToPath(danglingBlob));

    expect(existsSync(danglingPath)).toBe(true);

    const result = repo.gc()!;

    expect(result.objectCount).toBeGreaterThan(0);
    expect(existsSync(danglingPath)).toBe(false);
    expect(repo.readRef("HEAD")).toBe(reachableCommit);
    expect(repo.catFile(reachableBlob).type).toBe("blob");
    expect(repo.listReachableObjects()).not.toContain(danglingBlob);
  });
});
