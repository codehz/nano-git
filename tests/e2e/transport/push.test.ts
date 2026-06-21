/**
 * Push 高层 API 端到端测试
 *
 * 通过 HTTP 服务将 push() 的全套编排逻辑接入 git http-backend：
 *   parseRefSpec → determinePushRefs → checkFastForward → collectReachable
 *   → createPackWriter → buildReceivePackRequest → postReceivePack → parseReceivePackResult
 *
 * 不依赖手工构造协议报文，完整验证高层 push() 函数的网络路径行为。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { git, gitInit, createTempDir, cleanupDir, createFile, FIXED_AUTHOR } from "../helpers.ts";
import { startGitHttpBackendServer } from "./http-server.ts";
import { sha1 } from "@/core/types.ts";
import { createMemoryRepository } from "@/repository/index.ts";

// ============================================================================
// 辅助函数
// ============================================================================

function enableReceivePack(repoDir: string): void {
  const configPath = join(repoDir, "config");
  const config = readFileSync(configPath, "utf-8");
  if (!config.includes("http.receivepack")) {
    writeFileSync(configPath, config + "\n[http]\n\treceivepack = true\n");
  }
}

// ============================================================================
// 测试
// ============================================================================

describe("push() 端到端", () => {
  let tempDir: string;
  let serverRepoDir: string;
  let workDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof startGitHttpBackendServer>;

  beforeEach(() => {
    tempDir = createTempDir("e2e-push-cgi");

    // 1. 创建服务端裸仓库
    serverRepoDir = join(tempDir, "server.git");
    mkdirSync(serverRepoDir);
    git(["init", "--bare"], serverRepoDir);
    enableReceivePack(serverRepoDir);

    // 2. 创建初始提交并推送到服务端作为基准
    workDir = join(tempDir, "work");
    gitInit(workDir);
    createFile(workDir, "README.md", "# Hello\n");
    git(["add", "README.md"], workDir);
    git(["commit", "-m", "Initial commit"], workDir);
    git(["push", serverRepoDir, "main"], workDir);

    // 3. 启动 HTTP 服务
    server = startGitHttpBackendServer(tempDir, "/server.git");
    serverUrl = server.url;
  });

  afterEach(async () => {
    await server?.stop();
    cleanupDir(tempDir);
  });

  test("推送新分支到远端", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const fileHash = repo.writeBlob(Buffer.from("new branch content"));
    const treeHash = repo.createTree([{ mode: "100644", name: "new-branch.txt", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "New branch commit", author);
    repo.updateRef("refs/heads/new-feature", commitHash);

    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/new-feature:refs/heads/new-feature"],
    });

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
    expect(result.refUpdates[0]!.refName).toBe("refs/heads/new-feature");

    const serverRef = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/heads/new-feature"],
      tempDir,
    );
    expect(serverRef).toBe(commitHash);
  });

  test("通过 push 删除远程分支", async () => {
    // 1. 先用系统 git 创建 feature 分支并推送到服务端
    createFile(workDir, "FEATURE.md", "# Feature\n");
    git(["add", "FEATURE.md"], workDir);
    git(["commit", "-m", "Feature commit"], workDir);
    const branchHash = git(["rev-parse", "HEAD"], workDir);
    git(["push", serverRepoDir, "HEAD:refs/heads/feature"], workDir);

    const branchRef = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/feature"], tempDir);
    expect(branchRef).toBe(branchHash);

    // 2. 用 nano-git push 删除远程分支
    const deleteRepo = createMemoryRepository();
    const deleteResult = await deleteRepo.push(serverUrl, {
      refSpecs: [":refs/heads/feature"],
    });

    expect(deleteResult.refUpdates).toHaveLength(1);
    expect(deleteResult.refUpdates[0]!.success).toBe(true);
    expect(deleteResult.refUpdates[0]!.refName).toBe("refs/heads/feature");

    const branchList = git(["--git-dir", serverRepoDir, "branch", "-a"], tempDir);
    expect(branchList).not.toContain("feature");
  });

  test("non-fast-forward 推送到远端被本地预检拒绝", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 获取服务端 refs/heads/main 的哈希，用于制造分叉
    // 注意：这个哈希在本地 store 中不存在，但 checkFastForward 中 isAncestor 使用的是本地 store
    // 所以这里我们只需确保 remoteHash 不等于 localHash 且没有祖先关系即可
    const _remoteMainHash = sha1(
      git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/main"], tempDir),
    );

    // 本地创建分叉 commit
    const fileHash = repo.writeBlob(Buffer.from("divergent"));
    const treeHash = repo.createTree([{ mode: "100644", name: "d.txt", hash: fileHash }]);
    const divergentHash = repo.createCommit(treeHash, [], "Divergent", author);
    repo.updateRef("refs/heads/main", divergentHash);

    const pushPromise = repo.push(serverUrl, {
      refSpecs: ["refs/heads/main:refs/heads/main"],
    });

    expect(pushPromise).rejects.toThrow("Non-fast-forward");
  });

  test("non-fast-forward 但设 force 时可以通过", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const fileHash = repo.writeBlob(Buffer.from("forced"));
    const treeHash = repo.createTree([{ mode: "100644", name: "f.txt", hash: fileHash }]);
    const forceHash = repo.createCommit(treeHash, [], "Forced", author);
    repo.updateRef("refs/heads/main", forceHash);

    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/main:refs/heads/main"],
      force: true,
    });

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
    expect(result.refUpdates[0]!.refName).toBe("refs/heads/main");

    const serverRef = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/main"], tempDir);
    expect(serverRef).toBe(forceHash);
  });

  test("通过 push 推送 tag 到远端", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const fileHash = repo.writeBlob(Buffer.from("tagged content"));
    const treeHash = repo.createTree([{ mode: "100644", name: "tagged.txt", hash: fileHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Tagged commit", author);
    repo.updateRef("refs/tags/v1", commitHash);

    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/tags/v1:refs/tags/v1"],
    });

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
    expect(result.refUpdates[0]!.refName).toBe("refs/tags/v1");

    const serverRef = git(["--git-dir", serverRepoDir, "rev-parse", "refs/tags/v1"], tempDir);
    expect(serverRef).toBe(commitHash);
  });

  test("推送多个分支到远端", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 创建第一个分支的 commit
    const hashA = repo.writeBlob(Buffer.from("multi branch a"));
    const treeA = repo.createTree([{ mode: "100644", name: "a.txt", hash: hashA }]);
    const commitA = repo.createCommit(treeA, [], "Feature A", author);
    repo.updateRef("refs/heads/feature-a", commitA);

    // 创建第二个分支的 commit
    const hashB = repo.writeBlob(Buffer.from("multi branch b"));
    const treeB = repo.createTree([{ mode: "100644", name: "b.txt", hash: hashB }]);
    const commitB = repo.createCommit(treeB, [], "Feature B", author);
    repo.updateRef("refs/heads/feature-b", commitB);

    // 一次 push 两个 refspec
    const result = await repo.push(serverUrl, {
      refSpecs: [
        "refs/heads/feature-a:refs/heads/feature-a",
        "refs/heads/feature-b:refs/heads/feature-b",
      ],
    });

    expect(result.refUpdates).toHaveLength(2);
    expect(result.refUpdates[0]!.success).toBe(true);
    expect(result.refUpdates[1]!.success).toBe(true);
    expect(result.objectCount).toBeGreaterThan(0);

    const serverA = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/feature-a"], tempDir);
    expect(serverA).toBe(commitA);
    const serverB = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/feature-b"], tempDir);
    expect(serverB).toBe(commitB);
  });

  test("通过 push 推送注解 tag（annotated tag）到远端", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 先创建一个 commit 用于 tag 指向
    const blobHash = repo.writeBlob(Buffer.from("annotated tag content"));
    const treeHash = repo.createTree([{ mode: "100644", name: "annotated.txt", hash: blobHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Commit for annotated tag", author);
    repo.updateRef("refs/heads/main", commitHash);

    // 创建注解 tag
    const tagHash = repo.createAnnotatedTag("v1.0", commitHash, "Release v1.0", author);

    // push 注解 tag
    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/tags/v1.0:refs/tags/v1.0"],
    });

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
    expect(result.refUpdates[0]!.refName).toBe("refs/tags/v1.0");

    // 验证服务端 tag 对象存在且指向正确
    const serverTagHash = git(["--git-dir", serverRepoDir, "rev-parse", "refs/tags/v1.0"], tempDir);
    expect(serverTagHash).toBe(tagHash);

    const serverTagType = git(["--git-dir", serverRepoDir, "cat-file", "-t", tagHash], tempDir);
    expect(serverTagType).toBe("tag");

    const serverTaggedObject = git(
      ["--git-dir", serverRepoDir, "cat-file", "-p", tagHash],
      tempDir,
    );
    expect(serverTaggedObject).toContain(`object ${commitHash}`);
    expect(serverTaggedObject).toContain("tag v1.0");
  });

  test("通过 push 删除远程 tag", async () => {
    // 1. 先用系统 git 创建 tag 并推送到服务端
    createFile(workDir, "to-delete.txt", "will be deleted\n");
    git(["add", "to-delete.txt"], workDir);
    git(["commit", "-m", "Add file for tag"], workDir);
    const tagHash = git(["rev-parse", "HEAD"], workDir);
    git(["tag", "v-delete"], workDir);
    git(["push", serverRepoDir, "refs/tags/v-delete"], workDir);

    const serverTagRef = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/tags/v-delete"],
      tempDir,
    );
    expect(serverTagRef).toBe(tagHash);

    // 2. 用 nano-git push 删除远程 tag
    const deleteRepo = createMemoryRepository();
    const deleteResult = await deleteRepo.push(serverUrl, {
      refSpecs: [":refs/tags/v-delete"],
    });

    expect(deleteResult.refUpdates).toHaveLength(1);
    expect(deleteResult.refUpdates[0]!.success).toBe(true);
    expect(deleteResult.refUpdates[0]!.refName).toBe("refs/tags/v-delete");

    // 验证服务端 tag 已被删除
    const tagList = git(["--git-dir", serverRepoDir, "tag", "-l"], tempDir);
    expect(tagList).not.toContain("v-delete");
  });

  test("推送自定义目标分支名（本地 main → 远程 custom-branch）", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const blobHash = repo.writeBlob(Buffer.from("custom branch target"));
    const treeHash = repo.createTree([{ mode: "100644", name: "custom.txt", hash: blobHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Custom branch commit", author);
    repo.updateRef("refs/heads/main", commitHash);

    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/main:refs/heads/custom-branch"],
    });

    expect(result.refUpdates).toHaveLength(1);
    expect(result.refUpdates[0]!.success).toBe(true);
    expect(result.refUpdates[0]!.refName).toBe("refs/heads/custom-branch");

    const serverRef = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/heads/custom-branch"],
      tempDir,
    );
    expect(serverRef).toBe(commitHash);
  });

  test("everything-up-to-date：推送已存在的引用时仍返回成功", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 1. 第一次推送：建立远程分支
    const blobHash = repo.writeBlob(Buffer.from("up to date content"));
    const treeHash = repo.createTree([{ mode: "100644", name: "uptodate.txt", hash: blobHash }]);
    const commitHash = repo.createCommit(treeHash, [], "Uptodate commit", author);
    repo.updateRef("refs/heads/uptodate", commitHash);

    const firstResult = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/uptodate:refs/heads/uptodate"],
    });
    expect(firstResult.refUpdates).toHaveLength(1);
    expect(firstResult.refUpdates[0]!.success).toBe(true);

    // 2. 第二次推送完全相同的内容
    const secondResult = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/uptodate:refs/heads/uptodate"],
    });
    expect(secondResult.refUpdates).toHaveLength(1);
    expect(secondResult.refUpdates[0]!.success).toBe(true);
    expect(secondResult.refUpdates[0]!.refName).toBe("refs/heads/uptodate");
    // 没有新对象需要发送
    expect(secondResult.objectCount).toBe(0);
  });

  test("多次推送累积 commit", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 1. 推送第一个 commit
    const blob1 = repo.writeBlob(Buffer.from("commit 1"));
    const tree1 = repo.createTree([{ mode: "100644", name: "f1.txt", hash: blob1 }]);
    const commit1 = repo.createCommit(tree1, [], "First commit", author);
    repo.updateRef("refs/heads/incremental", commit1);

    const result1 = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/incremental:refs/heads/incremental"],
    });
    expect(result1.refUpdates[0]!.success).toBe(true);

    // 2. 在第一个 commit 之上再推送第二个 commit
    const blob2 = repo.writeBlob(Buffer.from("commit 2"));
    const tree2 = repo.createTree([
      { mode: "100644", name: "f1.txt", hash: blob1 },
      { mode: "100644", name: "f2.txt", hash: blob2 },
    ]);
    const commit2 = repo.createCommit(tree2, [commit1], "Second commit", author);
    repo.updateRef("refs/heads/incremental", commit2);

    const result2 = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/incremental:refs/heads/incremental"],
    });
    expect(result2.refUpdates[0]!.success).toBe(true);
    expect(result2.objectCount).toBeGreaterThan(0);

    // 3. 再推送第三个 commit
    const blob3 = repo.writeBlob(Buffer.from("commit 3"));
    const tree3 = repo.createTree([
      { mode: "100644", name: "f1.txt", hash: blob1 },
      { mode: "100644", name: "f2.txt", hash: blob2 },
      { mode: "100644", name: "f3.txt", hash: blob3 },
    ]);
    const commit3 = repo.createCommit(tree3, [commit2], "Third commit", author);
    repo.updateRef("refs/heads/incremental", commit3);

    const result3 = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/incremental:refs/heads/incremental"],
    });
    expect(result3.refUpdates[0]!.success).toBe(true);

    // 验证服务端最终状态
    const serverRef = git(
      ["--git-dir", serverRepoDir, "rev-parse", "refs/heads/incremental"],
      tempDir,
    );
    expect(serverRef).toBe(commit3);

    const serverLog = git(
      ["--git-dir", serverRepoDir, "log", "--oneline", "refs/heads/incremental"],
      tempDir,
    );
    expect(serverLog.split("\n")).toHaveLength(3);
  });

  test("通配符 refspec 推送所有分支（refs/heads/*:refs/heads/*）", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    // 创建两个分支
    const hashA = repo.writeBlob(Buffer.from("wildcard a"));
    const treeA = repo.createTree([{ mode: "100644", name: "wa.txt", hash: hashA }]);
    const commitA = repo.createCommit(treeA, [], "Wildcard A", author);
    repo.updateRef("refs/heads/branch-wa", commitA);

    const hashB = repo.writeBlob(Buffer.from("wildcard b"));
    const treeB = repo.createTree([{ mode: "100644", name: "wb.txt", hash: hashB }]);
    const commitB = repo.createCommit(treeB, [], "Wildcard B", author);
    repo.updateRef("refs/heads/branch-wb", commitB);

    // 使用通配符 refspec 推送
    const result = await repo.push(serverUrl, {
      refSpecs: ["refs/heads/*:refs/heads/*"],
    });

    expect(result.refUpdates).toHaveLength(2);
    expect(result.refUpdates.every((u) => u.success)).toBe(true);

    const serverA = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/branch-wa"], tempDir);
    expect(serverA).toBe(commitA);
    const serverB = git(["--git-dir", serverRepoDir, "rev-parse", "refs/heads/branch-wb"], tempDir);
    expect(serverB).toBe(commitB);
  });

  test("推送引用时本地 ref 不存在则抛出异常", async () => {
    const repo = createMemoryRepository();

    const pushPromise = repo.push(serverUrl, {
      refSpecs: ["refs/heads/non-existent:refs/heads/non-existent"],
    });

    expect(pushPromise).rejects.toThrow("Local ref not found");
  });

  test("tree 引用缺失 blob 时在客户端失败，不向 git-http-backend 发送不完整 pack", async () => {
    const repo = createMemoryRepository();
    const author = { ...FIXED_AUTHOR };

    const hashA = repo.writeBlob(Buffer.from("present blob"));
    const missingBlob = repo.hashObject(Buffer.from("missing blob"));
    const treeHash = repo.createTree([
      { mode: "100644", name: "ok.txt", hash: hashA },
      { mode: "100644", name: "missing.txt", hash: missingBlob },
    ]);
    const commitHash = repo.createCommit(treeHash, [], "Corrupt tree commit", author);
    repo.updateRef("refs/heads/corrupt-tree", commitHash);

    const pushPromise = repo.push(serverUrl, {
      refSpecs: ["refs/heads/corrupt-tree:refs/heads/corrupt-tree"],
    });

    expect(pushPromise).rejects.toThrow(/missing from the local store/i);

    const branchList = git(["--git-dir", serverRepoDir, "branch", "-a"], tempDir);
    expect(branchList).not.toContain("corrupt-tree");
  });
});
