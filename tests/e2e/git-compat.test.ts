/**
 * nano-git 与标准 Git 端到端兼容性测试
 *
 * 验证 nano-git 生成的 Git 对象能被标准 git 命令行工具正确读取，
 * 反之亦然。确保两者在底层数据结构上完全兼容。
 *
 * 测试策略：双向验证
 * 1. nano-git → git：用 nano-git 创建对象，用 git 命令验证
 * 2. git → nano-git：用 git 命令创建对象，用 nano-git API 验证
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initRepository, openRepository } from "../../src/repository.ts";
import { sha1 } from "../../src/types.ts";
import type { GitAuthor, GitTag } from "../../src/types.ts";
import {
  git,
  gitInit,
  gitHashObjectWrite,
  gitHashObject,
  gitCatFile,
  gitCatFileRaw,
  gitCatFileType,
  gitCatFileSize,
  gitWriteTreeFromFiles,
  gitCommitTree,
  gitUpdateRef,
  gitRevParse,
  gitLog,
  gitFsck,
  gitGc,
  createTempDir,
  cleanupDir,
  createFile,
  FIXED_AUTHOR,
} from "./helpers.ts";

// ============================================================================
// 测试用的固定作者信息（与 helpers.ts 中的 GIT_ENV 一致）
// ============================================================================

const testAuthor: GitAuthor = {
  name: FIXED_AUTHOR.name,
  email: FIXED_AUTHOR.email,
  timestamp: FIXED_AUTHOR.timestamp,
  timezone: FIXED_AUTHOR.timezone,
};

// ============================================================================
// Blob 兼容性
// ============================================================================

describe("Blob 兼容性", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-blob");
    gitInit(tempDir);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  // --- nano-git → git ---

  describe("nano-git → git", () => {
    test("nano-git 写入的 blob 能被 git cat-file 读取", () => {
      const repo = openRepository(tempDir);
      const content = "hello world from nano-git";
      const hash = repo.writeBlob(Buffer.from(content));

      // git 验证类型
      expect(gitCatFileType(tempDir, hash)).toBe("blob");

      // git 验证大小
      expect(gitCatFileSize(tempDir, hash)).toBe(Buffer.byteLength(content));

      // git 验证内容
      const rawContent = gitCatFileRaw(tempDir, hash);
      expect(rawContent.toString("utf-8")).toBe(content);
    });

    test("nano-git 和 git 对相同内容产生相同的哈希", () => {
      const repo = openRepository(tempDir);
      const content = "identical content test";

      const nanoGitHash = repo.hashObject(Buffer.from(content));
      const gitHash = gitHashObject(tempDir, content);

      expect(nanoGitHash).toBe(gitHash);
    });

    test("nano-git 写入的二进制 blob 能被 git 正确读取", () => {
      const repo = openRepository(tempDir);
      // 创建包含各种字节值的二进制内容
      const binaryContent = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f, 0x42, 0x13]);
      const hash = repo.writeBlob(binaryContent);

      const rawContent = gitCatFileRaw(tempDir, hash);
      expect(rawContent).toEqual(binaryContent);
    });

    test("nano-git 写入的空 blob 能被 git 正确读取", () => {
      const repo = openRepository(tempDir);
      const hash = repo.writeBlob(Buffer.from(""));

      expect(gitCatFileType(tempDir, hash)).toBe("blob");
      expect(gitCatFileSize(tempDir, hash)).toBe(0);
    });

    test("nano-git 写入的中文内容能被 git 正确读取", () => {
      const repo = openRepository(tempDir);
      const content = "你好世界 🌍 こんにちは";
      const hash = repo.writeBlob(Buffer.from(content));

      const rawContent = gitCatFileRaw(tempDir, hash);
      expect(rawContent.toString("utf-8")).toBe(content);
    });
  });

  // --- git → nano-git ---

  describe("git → nano-git", () => {
    test("git 写入的 blob 能被 nano-git 读取", () => {
      const repo = openRepository(tempDir);
      const content = "hello from git CLI";
      const hash = gitHashObjectWrite(tempDir, content);

      const obj = repo.catFile(sha1(hash));
      expect(obj.type).toBe("blob");
      if (obj.type === "blob") {
        expect(obj.content.toString("utf-8")).toBe(content);
      }
    });

    test("git 写入的二进制 blob 能被 nano-git 正确读取", () => {
      const repo = openRepository(tempDir);
      const binaryContent = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x42]);
      const hash = gitHashObjectWrite(tempDir, binaryContent);

      const obj = repo.catFile(sha1(hash));
      expect(obj.type).toBe("blob");
      if (obj.type === "blob") {
        expect(obj.content).toEqual(binaryContent);
      }
    });
  });
});

// ============================================================================
// Tree 兼容性
// ============================================================================

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

      // git cat-file -p 应该显示 tree 内容
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

      // 验证根 tree
      const rootOutput = gitCatFile(tempDir, rootTreeHash);
      expect(rootOutput).toContain("040000 tree");
      expect(rootOutput).toContain("subdir");

      // 验证子 tree
      const subOutput = gitCatFile(tempDir, subTreeHash);
      expect(subOutput).toContain("100644 blob");
      expect(subOutput).toContain("nested.txt");
    });

    test("nano-git 的 writeTree() 与 git 兼容", () => {
      // 在临时目录中创建文件结构
      const workDir = createTempDir("e2e-tree-work");
      try {
        createFile(workDir, "hello.txt", "hello world");
        createFile(workDir, "sub/nested.txt", "nested content");

        // 初始化 git 仓库（nano-git 需要 .git 目录）
        gitInit(workDir);

        const repo = openRepository(workDir);
        const treeHash = repo.writeTree(workDir);

        // git 应该能读取这个 tree
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

      // 用 nano-git 创建 tree
      const fileHash = repo.writeBlob(Buffer.from("same content"));
      const nanoGitTreeHash = repo.createTree([
        { mode: "100644", name: "same.txt", hash: fileHash },
      ]);

      // 用 git 创建相同内容的 tree
      const gitFileHash = gitHashObjectWrite(tempDir, "same content");
      expect(gitFileHash).toBe(fileHash);

      // 用 git update-index + write-tree
      const gitTreeHash = gitWriteTreeFromFiles(tempDir, {
        "same.txt": "same content",
      });

      expect(nanoGitTreeHash).toBe(gitTreeHash);
    });
  });
});

// ============================================================================
// Commit 兼容性
// ============================================================================

describe("Commit 兼容性", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-commit");
    gitInit(tempDir);
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

      // git 验证类型
      expect(gitCatFileType(tempDir, commitHash)).toBe("commit");

      // git cat-file -p 验证 commit 内容
      const output = gitCatFile(tempDir, commitHash);
      expect(output).toContain(`tree ${treeHash}`);
      expect(output).toContain(`author ${FIXED_AUTHOR.name} <${FIXED_AUTHOR.email}>`);
      expect(output).toContain(`committer ${FIXED_AUTHOR.name} <${FIXED_AUTHOR.email}>`);
      expect(output).toContain("Initial commit");
      // 初始 commit 不应有 parent
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

      // 更新 HEAD 引用
      repo.updateRef("refs/heads/main", commit2Hash);

      // git fsck 应该通过
      const fsckOutput = gitFsck(tempDir);
      // fsck 成功时通常输出为空或只有进度信息
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

      const treeHash = gitWriteTreeFromFiles(tempDir, {
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

      const treeHash = gitWriteTreeFromFiles(tempDir, {
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

      // 创建相同的 blob 和 tree
      const fileHash = repo.writeBlob(Buffer.from("same"));
      const treeHash = repo.createTree([{ mode: "100644", name: "same.txt", hash: fileHash }]);

      // nano-git 创建 commit（序列化时会自动规范化尾部换行符）
      const nanoGitCommit = repo.createCommit(treeHash, [], "Same message", testAuthor);

      // git 创建 commit（使用相同的环境变量确保 author/committer 一致）
      const gitCommit = gitCommitTree(tempDir, treeHash, "Same message");

      expect(nanoGitCommit).toBe(gitCommit);
    });
  });
});

// ============================================================================
// Tag 兼容性
// ============================================================================

describe("Tag 兼容性", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-tag");
    gitInit(tempDir);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  // --- nano-git → git ---

  describe("nano-git → git", () => {
    test("nano-git 创建的 tag 能被 git cat-file 读取", () => {
      const repo = openRepository(tempDir);

      const fileHash = repo.writeBlob(Buffer.from("tagged content"));
      const treeHash = repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]);
      const commitHash = repo.createCommit(treeHash, [], "Tagged commit", testAuthor);

      // 创建 tag 对象
      const tag: GitTag = {
        type: "tag",
        object: commitHash,
        objectType: "commit",
        tag: "v1.0.0",
        tagger: testAuthor,
        message: "Release v1.0.0\n",
      };
      const tagHash = repo.objects.write(tag);

      // git 验证
      expect(gitCatFileType(tempDir, tagHash)).toBe("tag");
      const output = gitCatFile(tempDir, tagHash);
      expect(output).toContain(`object ${commitHash}`);
      expect(output).toContain("type commit");
      expect(output).toContain("tag v1.0.0");
      expect(output).toContain(`tagger ${FIXED_AUTHOR.name} <${FIXED_AUTHOR.email}>`);
      expect(output).toContain("Release v1.0.0");
    });

    test("nano-git 创建的轻量标签能被 git rev-parse 读取", () => {
      const repo = openRepository(tempDir);

      const treeHash = repo.createTree([]);
      const commitHash = repo.createCommit(treeHash, [], "Lightweight tag", testAuthor);

      repo.createTag("v1.2.3", commitHash);

      expect(gitRevParse(tempDir, "refs/tags/v1.2.3")).toBe(commitHash);
    });

    test("nano-git 创建的 annotated tag 能被 git rev-parse 解析", () => {
      const repo = openRepository(tempDir);

      const treeHash = repo.createTree([]);
      const commitHash = repo.createCommit(treeHash, [], "Annotated tag", testAuthor);

      const tagHash = repo.createAnnotatedTag("v3.0.0", commitHash, "Release v3.0.0\n", testAuthor);

      expect(gitRevParse(tempDir, "refs/tags/v3.0.0")).toBe(tagHash);
      expect(gitRevParse(tempDir, "v3.0.0^{commit}")).toBe(commitHash);
    });
  });

  // --- git → nano-git ---

  describe("git → nano-git", () => {
    test("git 创建的 tag 能被 nano-git 正确读取", () => {
      const repo = openRepository(tempDir);

      // 先创建一个 commit
      const treeHash = gitWriteTreeFromFiles(tempDir, { "f.txt": "c" });
      const commitHash = gitCommitTree(tempDir, treeHash, "For tagging");

      // 用 git 创建 annotated tag
      const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
      const result = spawnSync("git", ["tag", "-a", "v2.0.0", "-m", "Version 2.0.0", commitHash], {
        cwd: tempDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: FIXED_AUTHOR.name,
          GIT_AUTHOR_EMAIL: FIXED_AUTHOR.email,
          GIT_AUTHOR_DATE: `${FIXED_AUTHOR.timestamp} ${FIXED_AUTHOR.timezone}`,
          GIT_COMMITTER_NAME: FIXED_AUTHOR.name,
          GIT_COMMITTER_EMAIL: FIXED_AUTHOR.email,
          GIT_COMMITTER_DATE: `${FIXED_AUTHOR.timestamp} ${FIXED_AUTHOR.timezone}`,
          GIT_CONFIG_NOSYSTEM: "1",
        },
        encoding: "utf-8",
      });
      expect(result.status).toBe(0);

      // 获取 tag 对象的 hash
      const tagObjHash = gitRevParse(tempDir, "v2.0.0");

      // nano-git 读取
      const obj = repo.catFile(sha1(tagObjHash));
      expect(obj.type).toBe("tag");
      if (obj.type === "tag") {
        expect(obj.object).toBe(commitHash);
        expect(obj.objectType).toBe("commit");
        expect(obj.tag).toBe("v2.0.0");
        expect(obj.message).toContain("Version 2.0.0");
      }
    });
  });
});

// ============================================================================
// Ref（引用）兼容性
// ============================================================================

describe("Ref 兼容性", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-ref");
    gitInit(tempDir);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  // --- nano-git → git ---

  describe("nano-git → git", () => {
    test("nano-git 更新的 ref 能被 git rev-parse 读取", () => {
      const repo = openRepository(tempDir);

      const treeHash = repo.createTree([]);
      const commitHash = repo.createCommit(treeHash, [], "Ref test", testAuthor);

      repo.updateRef("refs/heads/main", commitHash);

      const gitResult = gitRevParse(tempDir, "refs/heads/main");
      expect(gitResult).toBe(commitHash);
    });

    test("nano-git 更新的 HEAD 能被 git 正确解析", () => {
      const repo = openRepository(tempDir);

      const treeHash = repo.createTree([]);
      const commitHash = repo.createCommit(treeHash, [], "HEAD test", testAuthor);

      repo.updateRef("refs/heads/main", commitHash);

      // HEAD -> refs/heads/main -> commitHash
      const headResult = gitRevParse(tempDir, "HEAD");
      expect(headResult).toBe(commitHash);
    });

    test("nano-git 创建的自定义分支 ref 能被 git 读取", () => {
      const repo = openRepository(tempDir);

      const treeHash = repo.createTree([]);
      const commitHash = repo.createCommit(treeHash, [], "Feature branch", testAuthor);

      repo.createBranch("feature", commitHash);

      const gitResult = gitRevParse(tempDir, "refs/heads/feature");
      expect(gitResult).toBe(commitHash);
    });

    test("nano-git 创建的分支能被 git branch 列出", () => {
      const repo = openRepository(tempDir);

      const treeHash = repo.createTree([]);
      const commitHash = repo.createCommit(treeHash, [], "Branch list", testAuthor);
      repo.updateRef("refs/heads/main", commitHash);
      repo.createBranch("feature/api");

      const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
      const result = spawnSync("git", ["branch", "--list"], {
        cwd: tempDir,
        encoding: "utf-8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("feature/api");
      expect(result.stdout).toContain("main");
    });
  });

  // --- git → nano-git ---

  describe("git → nano-git", () => {
    test("git 更新的 ref 能被 nano-git 读取", () => {
      const repo = openRepository(tempDir);

      const treeHash = gitWriteTreeFromFiles(tempDir, { "f.txt": "c" });
      const commitHash = gitCommitTree(tempDir, treeHash, "Ref test");

      gitUpdateRef(tempDir, "refs/heads/main", commitHash);

      const nanoGitResult = repo.readRef("refs/heads/main");
      expect(nanoGitResult).toBe(commitHash);
    });

    test("nano-git 能解析 git 设置的 HEAD 符号引用", () => {
      const repo = openRepository(tempDir);

      const treeHash = gitWriteTreeFromFiles(tempDir, { "f.txt": "c" });
      const commitHash = gitCommitTree(tempDir, treeHash, "HEAD test");

      gitUpdateRef(tempDir, "refs/heads/main", commitHash);

      // HEAD 是符号引用 -> refs/heads/main -> commitHash
      const headResult = repo.readRef("HEAD");
      expect(headResult).toBe(commitHash);
    });
  });
});

// ============================================================================
// 完整工作流测试
// ============================================================================

describe("完整工作流", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-workflow");
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  test("nano-git 创建的完整仓库能被 git 正常使用", () => {
    // 用 nano-git 初始化仓库
    const repo = initRepository(tempDir);

    // 创建第一个 commit
    const readmeHash = repo.writeBlob(Buffer.from("# My Project\n\nHello world!\n"));
    const tree1Hash = repo.createTree([{ mode: "100644", name: "README.md", hash: readmeHash }]);
    const commit1Hash = repo.createCommit(tree1Hash, [], "Initial commit", testAuthor);
    repo.updateRef("refs/heads/main", commit1Hash);

    // 创建第二个 commit
    const srcHash = repo.writeBlob(Buffer.from('console.log("hello");\n'));
    const readmeV2Hash = repo.writeBlob(Buffer.from("# My Project\n\nHello world!\n\n## Usage\n"));
    const srcTreeHash = repo.createTree([{ mode: "100644", name: "index.js", hash: srcHash }]);
    const tree2Hash = repo.createTree([
      { mode: "100644", name: "README.md", hash: readmeV2Hash },
      { mode: "40000", name: "src", hash: srcTreeHash },
    ]);
    const commit2Hash = repo.createCommit(tree2Hash, [commit1Hash], "Add source code", testAuthor);
    repo.updateRef("refs/heads/main", commit2Hash);

    // 验证 git log
    const logOutput = gitLog(tempDir, "%H %s");
    expect(logOutput).toContain(commit2Hash);
    expect(logOutput).toContain("Add source code");
    expect(logOutput).toContain(commit1Hash);
    expect(logOutput).toContain("Initial commit");

    // 验证 git fsck
    const fsckOutput = gitFsck(tempDir);
    expect(fsckOutput).not.toContain("error");
    expect(fsckOutput).not.toContain("broken");

    // 验证 git cat-file 能读取所有对象
    expect(gitCatFileType(tempDir, commit2Hash)).toBe("commit");
    expect(gitCatFileType(tempDir, tree2Hash)).toBe("tree");
    expect(gitCatFileType(tempDir, srcTreeHash)).toBe("tree");
    expect(gitCatFileType(tempDir, readmeV2Hash)).toBe("blob");
    expect(gitCatFileType(tempDir, srcHash)).toBe("blob");
  });

  test("git 创建的完整仓库能被 nano-git 正确读取", () => {
    // 用 git 初始化仓库
    gitInit(tempDir);

    // 创建文件并提交
    createFile(tempDir, "hello.txt", "Hello from git!\n");

    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: FIXED_AUTHOR.name,
      GIT_AUTHOR_EMAIL: FIXED_AUTHOR.email,
      GIT_AUTHOR_DATE: `${FIXED_AUTHOR.timestamp} ${FIXED_AUTHOR.timezone}`,
      GIT_COMMITTER_NAME: FIXED_AUTHOR.name,
      GIT_COMMITTER_EMAIL: FIXED_AUTHOR.email,
      GIT_COMMITTER_DATE: `${FIXED_AUTHOR.timestamp} ${FIXED_AUTHOR.timezone}`,
      GIT_CONFIG_NOSYSTEM: "1",
    };

    // git add + commit
    spawnSync("git", ["add", "hello.txt"], { cwd: tempDir, env: gitEnv });
    spawnSync("git", ["commit", "-m", "Add hello.txt"], { cwd: tempDir, env: gitEnv });

    // 用 nano-git 读取
    const repo = openRepository(tempDir);

    // 读取 HEAD
    const headHash = repo.readRef("HEAD");
    expect(headHash).not.toBeNull();

    // 读取 commit
    const commit = repo.catFile(headHash!);
    expect(commit.type).toBe("commit");
    if (commit.type === "commit") {
      expect(commit.message).toContain("Add hello.txt");
      expect(commit.parents).toHaveLength(0);

      // 读取 tree
      const tree = repo.catFile(commit.tree);
      expect(tree.type).toBe("tree");
      if (tree.type === "tree") {
        const helloEntry = tree.entries.find((e) => e.name === "hello.txt");
        expect(helloEntry).toBeDefined();
        expect(helloEntry!.mode).toBe("100644");

        // 读取 blob
        const blob = repo.catFile(helloEntry!.hash);
        expect(blob.type).toBe("blob");
        if (blob.type === "blob") {
          expect(blob.content.toString("utf-8")).toBe("Hello from git!\n");
        }
      }
    }
  });

  test("nano-git 和 git 交替操作能保持仓库一致性", () => {
    // nano-git 初始化
    const repo = initRepository(tempDir);

    // nano-git 创建第一个 commit
    const file1Hash = repo.writeBlob(Buffer.from("version 1\n"));
    const tree1Hash = repo.createTree([{ mode: "100644", name: "data.txt", hash: file1Hash }]);
    const commit1Hash = repo.createCommit(tree1Hash, [], "nano-git: first commit", testAuthor);
    repo.updateRef("refs/heads/main", commit1Hash);

    // git 创建第二个 commit
    createFile(tempDir, "data.txt", "version 2\n");
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: FIXED_AUTHOR.name,
      GIT_AUTHOR_EMAIL: FIXED_AUTHOR.email,
      GIT_AUTHOR_DATE: `${FIXED_AUTHOR.timestamp} ${FIXED_AUTHOR.timezone}`,
      GIT_COMMITTER_NAME: FIXED_AUTHOR.name,
      GIT_COMMITTER_EMAIL: FIXED_AUTHOR.email,
      GIT_COMMITTER_DATE: `${FIXED_AUTHOR.timestamp} ${FIXED_AUTHOR.timezone}`,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    spawnSync("git", ["add", "data.txt"], { cwd: tempDir, env: gitEnv });
    spawnSync("git", ["commit", "-m", "git: second commit"], { cwd: tempDir, env: gitEnv });

    // nano-git 读取 git 创建的 commit
    const headHash = repo.readRef("HEAD");
    expect(headHash).not.toBeNull();

    const gitCommit = repo.catFile(headHash!);
    expect(gitCommit.type).toBe("commit");
    if (gitCommit.type === "commit") {
      expect(gitCommit.message).toContain("git: second commit");
      expect(gitCommit.parents).toHaveLength(1);
      expect(gitCommit.parents[0]).toBe(commit1Hash);
    }

    // git fsck 验证完整性
    const fsckOutput = gitFsck(tempDir);
    expect(fsckOutput).not.toContain("error");
    expect(fsckOutput).not.toContain("broken");
  });

  test("nano-git gc 后仓库仍能被 git 正常读取", () => {
    const repo = initRepository(tempDir);
    const blobHash = repo.writeBlob(Buffer.from("tracked"));
    const treeHash = repo.createTree([{ mode: "100644", name: "tracked.txt", hash: blobHash }]);
    const commitHash = repo.createCommit(treeHash, [], "keep", testAuthor);
    repo.updateRef("refs/heads/main", commitHash);

    repo.writeBlob(Buffer.from("dangling"));
    repo.gc();

    expect(gitRevParse(tempDir, "HEAD")).toBe(commitHash);
    expect(gitCatFile(tempDir, blobHash)).toBe("tracked");

    const fsckOutput = gitFsck(tempDir);
    expect(fsckOutput).not.toContain("error");
    expect(fsckOutput).not.toContain("broken");
  });

  test("git gc 后的仓库仍能被 nano-git 读取，可达性与 refs 一致", () => {
    gitInit(tempDir);
    createFile(tempDir, "keep.txt", "keep");
    git(["add", "keep.txt"], tempDir);
    git(["commit", "-m", "keep"], tempDir);
    gitHashObjectWrite(tempDir, "dangling");
    gitGc(tempDir, true);

    const repo = openRepository(tempDir);
    const reachable = repo.listReachableObjects();
    const headHash = gitRevParse(tempDir, "HEAD");

    expect(reachable).toContain(headHash);
    expect(repo.readRef("HEAD")).toBe(headHash);
  });
});
