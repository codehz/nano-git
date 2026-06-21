/**
 * Tree 端到端兼容性测试
 *
 * nano-git 与标准 Git 的 Tree 对象双向兼容性验证，包括符号链接。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";

import {
  git,
  gitInit,
  gitHashObjectWrite,
  gitHashObject,
  gitCatFile,
  gitCatFileType,
  gitCatFileRaw,
  gitWriteTreeFromFiles,
  createTempDir,
  cleanupDir,
  createFile,
} from "./helpers.ts";
import { sha1 } from "@/core/types.ts";
import { openRepository } from "@/repository/index.ts";

describe("Tree 兼容性", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-tree");
    gitInit(tempDir);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  // --- nano-git → git ---

  describe("nano-git → git", () => {
    test("nano-git 创建的简单 tree 能被 git 正确读取", () => {
      const repo = openRepository(tempDir);

      const fileHash = repo.writeBlob(Buffer.from("file content"));
      const treeHash = repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]);

      const output = gitCatFile(tempDir, treeHash);
      expect(output).toContain("100644 blob");
      expect(output).toContain("file.txt");
      expect(output).toContain(fileHash);
    });

    test("nano-git 创建的多文件 tree 能被 git 正确读取", () => {
      const repo = openRepository(tempDir);

      const hash1 = repo.writeBlob(Buffer.from("content 1"));
      const hash2 = repo.writeBlob(Buffer.from("content 2"));
      const hash3 = repo.writeBlob(Buffer.from("#!/bin/sh\necho hi"));

      const treeHash = repo.createTree([
        { mode: "100644", name: "a.txt", hash: hash1 },
        { mode: "100644", name: "b.txt", hash: hash2 },
        { mode: "100755", name: "script.sh", hash: hash3 },
      ]);

      const output = gitCatFile(tempDir, treeHash);
      expect(output).toContain("100644 blob");
      expect(output).toContain("a.txt");
      expect(output).toContain("b.txt");
      expect(output).toContain("100755 blob");
      expect(output).toContain("script.sh");
    });

    test("nano-git 创建的嵌套 tree（子目录）能被 git 正确读取", () => {
      const repo = openRepository(tempDir);

      const fileHash = repo.writeBlob(Buffer.from("nested file"));
      const subTreeHash = repo.createTree([{ mode: "100644", name: "nested.txt", hash: fileHash }]);
      const rootTreeHash = repo.createTree([{ mode: "40000", name: "subdir", hash: subTreeHash }]);

      const rootOutput = gitCatFile(tempDir, rootTreeHash);
      expect(rootOutput).toContain("040000 tree");
      expect(rootOutput).toContain("subdir");

      const subOutput = gitCatFile(tempDir, subTreeHash);
      expect(subOutput).toContain("100644 blob");
      expect(subOutput).toContain("nested.txt");
    });

    test("nano-git 的 writeTree() 与 git 兼容", () => {
      const workDir = createTempDir("e2e-tree-work");
      try {
        createFile(workDir, "hello.txt", "hello world");
        createFile(workDir, "sub/nested.txt", "nested content");

        gitInit(workDir);

        const repo = openRepository(workDir);
        const treeHash = repo.writeTree(workDir);

        expect(gitCatFileType(workDir, treeHash)).toBe("tree");
        const output = gitCatFile(workDir, treeHash);
        expect(output).toContain("hello.txt");
        expect(output).toContain("sub");
      } finally {
        cleanupDir(workDir);
      }
    });
  });

  // --- git → nano-git ---

  describe("git → nano-git", () => {
    test("git 创建的 tree 能被 nano-git 正确读取", () => {
      const repo = openRepository(tempDir);

      const treeHash = gitWriteTreeFromFiles(tempDir, {
        "file1.txt": "content 1",
        "file2.txt": "content 2",
      });

      const obj = repo.catFile(sha1(treeHash));
      expect(obj.type).toBe("tree");
      if (obj.type === "tree") {
        expect(obj.entries).toHaveLength(2);
        expect(obj.entries[0]!.name).toBe("file1.txt");
        expect(obj.entries[0]!.mode).toBe("100644");
        expect(obj.entries[1]!.name).toBe("file2.txt");
      }
    });

    test("git 和 nano-git 对相同 tree 结构产生相同的哈希", () => {
      const repo = openRepository(tempDir);

      const fileHash = repo.writeBlob(Buffer.from("same content"));
      const nanoGitTreeHash = repo.createTree([
        { mode: "100644", name: "same.txt", hash: fileHash },
      ]);

      const gitFileHash = gitHashObjectWrite(tempDir, "same content");
      expect(gitFileHash).toBe(fileHash);

      const gitTreeHash = gitWriteTreeFromFiles(tempDir, {
        "same.txt": "same content",
      });

      expect(nanoGitTreeHash).toBe(gitTreeHash);
    });
  });

  // --- 符号链接兼容性 ---

  describe("nano-git → git 符号链接", () => {
    test("nano-git createTree 创建的符号链接 tree 能被 git ls-tree 正确显示", () => {
      const repo = openRepository(tempDir);

      const targetHash = repo.writeBlob(Buffer.from("/usr/bin/node"));
      const treeHash = repo.createTree([{ mode: "120000", name: "node", hash: targetHash }]);

      const output = git(["ls-tree", treeHash], tempDir);
      expect(output).toMatch(/^120000 blob [a-f0-9]+\tnode$/m);
    });

    test("nano-git writeTree 处理的符号链接能被 git 正确读取", () => {
      const workDir = createTempDir("e2e-symlink-work");
      try {
        symlinkSync("/usr/bin/python3", join(workDir, "python-link"));
        gitInit(workDir);

        const repo = openRepository(workDir);
        const treeHash = repo.writeTree(workDir);

        const output = git(["ls-tree", treeHash], workDir);
        expect(output).toMatch(/^120000 blob [a-f0-9]+\tpython-link$/m);

        const match = output.match(/^120000 blob ([a-f0-9]+)\tpython-link$/m);
        expect(match).not.toBeNull();
        if (match) {
          const blobContent = gitCatFileRaw(workDir, match[1]!);
          expect(blobContent.toString("utf-8")).toBe("/usr/bin/python3");
        }
      } finally {
        cleanupDir(workDir);
      }
    });

    test("nano-git 写入的符号链接内容与 git hash-object 一致", () => {
      const repo = openRepository(tempDir);

      const target = "/some/symlink/target";
      const nanoGitHash = repo.writeBlob(Buffer.from(target));
      const gitHash = gitHashObject(tempDir, target);

      expect(nanoGitHash).toBe(gitHash);
    });
  });

  describe("git → nano-git 符号链接", () => {
    test("git update-index 添加的符号链接能被 nano-git 正确解析", () => {
      const repo = openRepository(tempDir);

      const blobHash = gitHashObjectWrite(tempDir, "/usr/bin/node");
      git(["update-index", "--add", "--cacheinfo", `120000,${blobHash},node-link`], tempDir);
      const gitTreeHash = git(["write-tree"], tempDir);

      const tree = repo.catFile(sha1(gitTreeHash));
      expect(tree.type).toBe("tree");
      if (tree.type === "tree") {
        expect(tree.entries).toHaveLength(1);
        expect(tree.entries[0]!.mode).toBe("120000");
        expect(tree.entries[0]!.name).toBe("node-link");

        const blob = repo.catFile(tree.entries[0]!.hash);
        expect(blob.type).toBe("blob");
        if (blob.type === "blob") {
          expect(blob.content.toString("utf-8")).toBe("/usr/bin/node");
        }
      }
    });

    test("git 和 nano-git 对相同符号链接产生相同的 tree 哈希", () => {
      const repo = openRepository(tempDir);

      const gitBlobHash = gitHashObjectWrite(tempDir, "/target/path");
      git(["update-index", "--add", "--cacheinfo", `120000,${gitBlobHash},symlink`], tempDir);
      const gitTreeHash = git(["write-tree"], tempDir);

      const nanoBlobHash = repo.writeBlob(Buffer.from("/target/path"));
      expect(nanoBlobHash).toBe(gitBlobHash);

      const nanoTreeHash = repo.createTree([
        { mode: "120000", name: "symlink", hash: nanoBlobHash },
      ]);

      expect(nanoTreeHash).toBe(sha1(gitTreeHash));
    });

    test("git 和 nano-git 对工作目录中相同的符号链接产生相同的 write-tree 结果", () => {
      const workDir = createTempDir("e2e-symlink-writetree");
      try {
        gitInit(workDir);

        symlinkSync("/usr/local/bin/app", join(workDir, "app-link"));

        const nanoRepo = openRepository(workDir);
        const nanoTreeHash = nanoRepo.writeTree(workDir);

        git(["add", "app-link"], workDir);
        const gitTreeHash = sha1(git(["write-tree"], workDir));

        expect(nanoTreeHash).toBe(gitTreeHash);
      } finally {
        cleanupDir(workDir);
      }
    });
  });
});
