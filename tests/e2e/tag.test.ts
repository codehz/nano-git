/**
 * Tag 端到端兼容性测试
 *
 * nano-git 与标准 Git 的 Tag 对象双向兼容性验证。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { openRepository } from "../../src/repository/index.ts";
import { sha1 } from "../../src/core/types.ts";
import type { GitAuthor, GitTag } from "../../src/core/types.ts";
import {
  git,
  gitInit,
  gitCatFile,
  gitCatFileType,
  gitRevParse,
  gitWriteTreeFromFiles,
  gitCommitTree,
  createTempDir,
  cleanupDir,
  createFile,
  FIXED_AUTHOR,
} from "./helpers.ts";

const testAuthor: GitAuthor = {
  name: FIXED_AUTHOR.name,
  email: FIXED_AUTHOR.email,
  timestamp: FIXED_AUTHOR.timestamp,
  timezone: FIXED_AUTHOR.timezone,
};

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

      const tag: GitTag = {
        type: "tag",
        object: commitHash,
        objectType: "commit",
        tag: "v1.0.0",
        tagger: testAuthor,
        message: "Release v1.0.0\n",
      };
      const tagHash = repo.objects.write(tag);

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

      const treeHash = gitWriteTreeFromFiles(tempDir, { "f.txt": "c" });
      const commitHash = gitCommitTree(tempDir, treeHash, "For tagging");

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

      const tagObjHash = gitRevParse(tempDir, "v2.0.0");

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
