/**
 * Packfile 端到端兼容性测试
 *
 * 验证 nano-git 生成的 Packfile 能被标准 git 正确读取，
 * 以及 git 生成的 Packfile 能被 nano-git 正确读取。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  gitInit,
  gitInitBare,
  git,
  gitCatFileRaw,
  gitRevParse,
  createTempDir,
  cleanupDir,
  createFile,
  FIXED_AUTHOR,
} from "./helpers.ts";
import { encodeObject, readObject } from "@/objects/raw.ts";
import { createPackBuilder } from "@/pack/pack-builder.ts";
import { createPackObjectStore } from "@/pack/pack-store.ts";

import type { GitBlob, GitTree, GitCommit, GitAuthor, SHA1 } from "@/core/types.ts";

const testAuthor: GitAuthor = {
  name: FIXED_AUTHOR.name,
  email: FIXED_AUTHOR.email,
  timestamp: FIXED_AUTHOR.timestamp,
  timezone: FIXED_AUTHOR.timezone,
};

// ============================================================================
// nano-git → git 兼容性
// ============================================================================

describe("Packfile 兼容性: nano-git → git", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-pack-n2g");
    gitInitBare(tempDir);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  test("nano-git 创建的 packfile 能被 git verify-pack 验证", () => {
    const builder = createPackBuilder(tempDir);

    const blob: GitBlob = { type: "blob", content: Buffer.from("hello from nano-git pack") };
    builder.addRaw(encodeObject(blob));

    const result = builder.build();
    expect(existsSync(result.packPath)).toBe(true);
    expect(existsSync(result.idxPath)).toBe(true);

    const output = git(["verify-pack", "-v", result.idxPath], tempDir);
    expect(output).toContain("blob");
  });

  test("nano-git 打包的 blob 能被 git cat-file 读取", () => {
    const builder = createPackBuilder(tempDir);

    const content = "packed blob content";
    const blob: GitBlob = { type: "blob", content: Buffer.from(content) };
    const hash = builder.addRaw(encodeObject(blob));
    builder.build();

    const gitContent = git(["cat-file", "-p", hash], tempDir);
    expect(gitContent).toBe(content);
  });

  test("nano-git 打包的 tree 能被 git cat-file 读取", () => {
    const builder = createPackBuilder(tempDir);

    const blob: GitBlob = { type: "blob", content: Buffer.from("file content") };
    const blobHash = builder.addRaw(encodeObject(blob));

    const tree: GitTree = {
      type: "tree",
      entries: [{ mode: "100644", name: "test.txt", hash: blobHash }],
    };
    const treeHash = builder.addRaw(encodeObject(tree));
    builder.build();

    const output = git(["cat-file", "-p", treeHash], tempDir);
    expect(output).toContain("test.txt");
    expect(output).toContain(blobHash);
  });

  test("nano-git 打包的 commit 能被 git cat-file 读取", () => {
    const builder = createPackBuilder(tempDir);

    const tree: GitTree = { type: "tree", entries: [] };
    const treeHash = builder.addRaw(encodeObject(tree));

    const commit: GitCommit = {
      type: "commit",
      tree: treeHash,
      parents: [],
      author: testAuthor,
      committer: testAuthor,
      message: "packed commit",
    };
    const commitHash = builder.addRaw(encodeObject(commit));
    builder.build();

    const output = git(["cat-file", "-p", commitHash], tempDir);
    expect(output).toContain("packed commit");
    expect(output).toContain(treeHash);
  });
});

// ============================================================================
// git → nano-git 兼容性
// ============================================================================

describe("Packfile 兼容性: git → nano-git", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("e2e-pack-g2n");
    gitInit(tempDir);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  test("git repack 生成的 packfile 能被 nano-git 读取", () => {
    createFile(tempDir, "file1.txt", "content 1");
    createFile(tempDir, "file2.txt", "content 2");

    git(["add", "."], tempDir);
    git(["commit", "-m", "test commit"], tempDir);

    git(["repack", "-a", "-d"], tempDir);

    const gitDir = join(tempDir, ".git");
    const store = createPackObjectStore(gitDir);

    expect(store.packCount).toBeGreaterThan(0);
    expect(store.objectCount).toBeGreaterThan(0);

    const hashes = store.listHashes();
    expect(hashes.length).toBeGreaterThan(0);

    for (const hash of hashes) {
      const obj = store.read(hash);
      expect(obj).toBeDefined();
      expect(["blob", "tree", "commit"]).toContain(obj.type);
    }
  });

  test("git gc 后的 packfile 能被 nano-git 正确解析", () => {
    for (let i = 0; i < 5; i++) {
      createFile(tempDir, `file${i}.txt`, `content ${i}`);
      git(["add", "."], tempDir);
      git(["commit", "-m", `commit ${i}`], tempDir);
    }

    git(["gc", "--aggressive"], tempDir);

    const gitDir = join(tempDir, ".git");
    const store = createPackObjectStore(gitDir);

    expect(store.packCount).toBeGreaterThan(0);

    const hashes = store.listHashes();
    for (const hash of hashes) {
      expect(() => store.read(hash)).not.toThrow();
    }
  });

  test("高相似 blob 的 delta pack 能被正确还原", () => {
    const expectedContents: Array<{ hash: string; content: string }> = [];

    for (let i = 0; i < 6; i++) {
      const content =
        "shared-header\n" +
        "A".repeat(4096) +
        `\nversion=${i}\n` +
        "B".repeat(4096) +
        "\nshared-footer\n";
      createFile(tempDir, "story.txt", content);
      git(["add", "story.txt"], tempDir);
      git(["commit", "-m", `story ${i}`], tempDir);
      expectedContents.push({
        hash: gitRevParse(tempDir, `HEAD:story.txt`),
        content,
      });
    }

    git(["repack", "-a", "-d", "-f", "--depth=50", "--window=50"], tempDir);

    const gitDir = join(tempDir, ".git");
    const store = createPackObjectStore(gitDir);

    for (const { hash, content } of expectedContents) {
      const obj = store.read(hash as ReturnType<typeof gitRevParse>);
      expect(obj.type).toBe("blob");
      if (obj.type === "blob") {
        expect(obj.content.toString("utf-8")).toBe(content);
      }
    }
  });

  test("annotated tag 进入 pack 后能被 nano-git 读取", () => {
    createFile(tempDir, "release.txt", "release payload");
    git(["add", "release.txt"], tempDir);
    git(["commit", "-m", "release commit"], tempDir);
    git(["tag", "-a", "v1.0.0", "-m", "release tag"], tempDir);

    const commitHash = gitRevParse(tempDir, "HEAD");
    const tagHash = gitRevParse(tempDir, "refs/tags/v1.0.0^{tag}");

    git(["gc", "--aggressive"], tempDir);

    const store = createPackObjectStore(join(tempDir, ".git"));
    const commitObj = readObject(store, commitHash);
    const tagObj = readObject(store, tagHash);

    expect(commitObj.type).toBe("commit");
    expect(tagObj.type).toBe("tag");
    if (tagObj.type === "tag") {
      expect(tagObj.object).toBe(commitHash);
      expect(tagObj.objectType).toBe("commit");
      expect(tagObj.tag).toBe("v1.0.0");
      expect(tagObj.message).toBe("release tag");
    }
  });

  test("delta pack 中的对象内容与 git cat-file 原始输出一致", () => {
    const blobHashes: SHA1[] = [];

    for (let i = 0; i < 4; i++) {
      const content =
        "prefix\n" + "x".repeat(2048) + `\nchunk=${i}\n` + "y".repeat(2048) + "\nsuffix\n";
      createFile(tempDir, `chunk-${i}.txt`, content);
      git(["add", `chunk-${i}.txt`], tempDir);
      git(["commit", "-m", `chunk ${i}`], tempDir);
      blobHashes.push(gitRevParse(tempDir, `HEAD:chunk-${i}.txt`));
    }

    git(["repack", "-a", "-d", "-f", "--depth=50", "--window=50"], tempDir);

    const store = createPackObjectStore(join(tempDir, ".git"));
    for (const hash of blobHashes) {
      const obj = store.read(hash);
      const gitRaw = gitCatFileRaw(tempDir, hash);

      expect(obj.type).toBe("blob");
      if (obj.type === "blob") {
        expect(obj.content).toEqual(gitRaw);
      }
    }
  });

  test("git multi-pack-index write 生成的 MIDX 可被 nano-git 读取", () => {
    // 制造多个 pack，使 MIDX 有意义
    for (let i = 0; i < 3; i++) {
      createFile(tempDir, `midx-file-${i}.txt`, `midx content ${i}`);
      git(["add", `.`], tempDir);
      git(["commit", "-m", `midx commit ${i}`], tempDir);
    }

    // 让 git 保留多个 pack 并写入 MIDX
    git(["repack", "-d"], tempDir);
    git(["multi-pack-index", "write"], tempDir);

    const gitDir = join(tempDir, ".git");
    const store = createPackObjectStore(gitDir);

    // 有 MIDX 时 listHashes 返回去重后的全局 OID 列表
    expect(store.objectCount).toBeGreaterThan(0);

    const hashes = store.listHashes();
    expect(hashes.length).toBe(store.objectCount);

    for (const hash of hashes) {
      expect(store.exists(hash)).toBe(true);
      const obj = store.read(hash);
      expect(obj).toBeDefined();
      expect(["blob", "tree", "commit", "tag"]).toContain(obj.type);
    }

    // 验证未纳入 MIDX 的 pack 回退：删除 MIDX 后对象数应不变
    rmSync(join(gitDir, "objects", "pack", "multi-pack-index"));
    store.refresh();
    const hashesWithoutMidx = store.listHashes();
    expect(hashesWithoutMidx.length).toBeGreaterThanOrEqual(hashes.length);
  });
});
