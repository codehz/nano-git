/**
 * Commit 端到端兼容性测试
 *
 * nano-git 与标准 Git 的 Commit 对象双向兼容性验证。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import {
  gitInitBare,
  gitCatFile,
  gitCatFileType,
  gitWriteTreeBare,
  gitCommitTree,
  gitFsck,
  gitLog,
  createTempDir,
  cleanupDir,
  FIXED_AUTHOR,
} from "./helpers.ts";
import { openRepository } from "@/repository/file.ts";
import { sha1 } from "@/types/index.ts";

import type { GitAuthor } from "@/types/index.ts";

const testAuthor: GitAuthor = {
  name: FIXED_AUTHOR.name,
  email: FIXED_AUTHOR.email,
  timestamp: FIXED_AUTHOR.timestamp,
  timezone: FIXED_AUTHOR.timezone,
};

describe("Commit 兼容性", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-commit");
    gitInitBare(tempDir);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  // --- nano-git → git ---

  describe("nano-git → git", () => {
    test("nano-git 创建的初始 commit 能被 git 正确读取", () => {
      const repo = openRepository(tempDir);

      const fileHash = repo.writeBlob(Buffer.from("initial content"));
      const treeHash = repo.createTree([{ mode: "100644", name: "README.md", hash: fileHash }]);
      const commitHash = repo.createCommit(treeHash, [], "Initial commit", testAuthor);

      expect(gitCatFileType(tempDir, commitHash)).toBe("commit");

      const output = gitCatFile(tempDir, commitHash);
      expect(output).toContain(`tree ${treeHash}`);
      expect(output).toContain(`author ${FIXED_AUTHOR.name} <${FIXED_AUTHOR.email}>`);
      expect(output).toContain(`committer ${FIXED_AUTHOR.name} <${FIXED_AUTHOR.email}>`);
      expect(output).toContain("Initial commit");
      expect(output).not.toContain("parent");
    });

    test("nano-git 创建的带父节点 commit 能被 git 正确读取", () => {
      const repo = openRepository(tempDir);

      const treeHash = repo.createTree([]);
      const parentHash = repo.createCommit(treeHash, [], "First commit", testAuthor);
      const childHash = repo.createCommit(treeHash, [parentHash], "Second commit", testAuthor);

      const output = gitCatFile(tempDir, childHash);
      expect(output).toContain(`parent ${parentHash}`);
      expect(output).toContain("Second commit");
    });

    test("nano-git 创建的 merge commit 能被 git 正确读取", () => {
      const repo = openRepository(tempDir);

      const treeHash = repo.createTree([]);
      const parent1 = repo.createCommit(treeHash, [], "Branch A", testAuthor);
      const parent2 = repo.createCommit(treeHash, [], "Branch B", testAuthor);
      const mergeHash = repo.createCommit(
        treeHash,
        [parent1, parent2],
        "Merge branches",
        testAuthor,
      );

      const output = gitCatFile(tempDir, mergeHash);
      expect(output).toContain(`parent ${parent1}`);
      expect(output).toContain(`parent ${parent2}`);
      expect(output).toContain("Merge branches");
    });

    test("nano-git commit 的 author/committer 格式与 git 兼容", () => {
      const repo = openRepository(tempDir);

      const customAuthor: GitAuthor = {
        name: "张三",
        email: "zhangsan@example.com",
        timestamp: 1609459200,
        timezone: "+0800",
      };
      const customCommitter: GitAuthor = {
        name: "李四",
        email: "lisi@example.com",
        timestamp: 1609459300,
        timezone: "-0500",
      };

      const treeHash = repo.createTree([]);
      const commitHash = repo.createCommit(
        treeHash,
        [],
        "Test author format",
        customAuthor,
        customCommitter,
      );

      const output = gitCatFile(tempDir, commitHash);
      expect(output).toContain("author 张三 <zhangsan@example.com> 1609459200 +0800");
      expect(output).toContain("committer 李四 <lisi@example.com> 1609459300 -0500");
    });

    test("nano-git commit 的多行 message 能被 git 正确读取", () => {
      const repo = openRepository(tempDir);

      const treeHash = repo.createTree([]);
      const message = "Subject line\n\nThis is the body.\n\n- Point 1\n- Point 2\n";
      const commitHash = repo.createCommit(treeHash, [], message, testAuthor);

      const output = gitCatFile(tempDir, commitHash);
      expect(output).toContain("Subject line");
      expect(output).toContain("This is the body.");
      expect(output).toContain("- Point 1");
      expect(output).toContain("- Point 2");
    });

    test("nano-git 创建的 commit 链能通过 git fsck 验证", () => {
      const repo = openRepository(tempDir);

      const file1Hash = repo.writeBlob(Buffer.from("v1"));
      const tree1Hash = repo.createTree([{ mode: "100644", name: "file.txt", hash: file1Hash }]);
      const commit1Hash = repo.createCommit(tree1Hash, [], "First", testAuthor);

      const file2Hash = repo.writeBlob(Buffer.from("v2"));
      const tree2Hash = repo.createTree([{ mode: "100644", name: "file.txt", hash: file2Hash }]);
      const commit2Hash = repo.createCommit(tree2Hash, [commit1Hash], "Second", testAuthor);

      repo.updateRef("refs/heads/main", commit2Hash);

      const fsckOutput = gitFsck(tempDir);
      expect(fsckOutput).not.toContain("error");
      expect(fsckOutput).not.toContain("broken");
    });

    test("nano-git 创建的 commit 能被 git log 显示", () => {
      const repo = openRepository(tempDir);

      const fileHash = repo.writeBlob(Buffer.from("content"));
      const treeHash = repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]);
      const commitHash = repo.createCommit(treeHash, [], "Test log message", testAuthor);

      repo.updateRef("refs/heads/main", commitHash);

      const logOutput = gitLog(tempDir, "%H %s");
      expect(logOutput).toContain(commitHash);
      expect(logOutput).toContain("Test log message");
    });
  });

  // --- git → nano-git ---

  describe("git → nano-git", () => {
    test("git 创建的 commit 能被 nano-git 正确读取", () => {
      const repo = openRepository(tempDir);

      const treeHash = gitWriteTreeBare(tempDir, {
        "test.txt": "test content",
      });
      const commitHash = gitCommitTree(tempDir, treeHash, "Git created commit");

      const obj = repo.catFile(sha1(commitHash));
      expect(obj.type).toBe("commit");
      if (obj.type === "commit") {
        expect(obj.tree).toBe(treeHash);
        expect(obj.message).toBe("Git created commit");
        expect(obj.parents).toHaveLength(0);
        expect(obj.author.name).toBe(FIXED_AUTHOR.name);
        expect(obj.author.email).toBe(FIXED_AUTHOR.email);
      }
    });

    test("git 创建的带父节点 commit 能被 nano-git 正确读取", () => {
      const repo = openRepository(tempDir);

      const treeHash = gitWriteTreeBare(tempDir, {
        "test.txt": "content",
      });
      const parentHash = gitCommitTree(tempDir, treeHash, "Parent");
      const childHash = gitCommitTree(tempDir, treeHash, "Child", [parentHash]);

      const obj = repo.catFile(sha1(childHash));
      expect(obj.type).toBe("commit");
      if (obj.type === "commit") {
        expect(obj.parents).toHaveLength(1);
        expect(obj.parents[0]).toBe(parentHash);
        expect(obj.message).toBe("Child");
      }
    });

    test("git 和 nano-git 对相同 commit 参数产生相同的哈希", () => {
      const repo = openRepository(tempDir);

      const fileHash = repo.writeBlob(Buffer.from("same"));
      const treeHash = repo.createTree([{ mode: "100644", name: "same.txt", hash: fileHash }]);

      const nanoGitCommit = repo.createCommit(treeHash, [], "Same message", testAuthor);
      const gitCommit = gitCommitTree(tempDir, treeHash, "Same message");

      expect(nanoGitCommit).toBe(gitCommit);
    });
  });
});
