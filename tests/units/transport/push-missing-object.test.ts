/**
 * Push 缺失对象场景单元测试
 *
 * 验证 collectReachable 在 missing="throw" 模式下能及时检测到
 * 本地仓库缺失对象并报错，而非静默生成不完整 packfile。
 */

import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";

import { sha1, type SHA1, type GitBlob, type GitTree, type GitCommit } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory-store.ts";
import { collectReachable, PushError } from "@/transport/push.ts";

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 计算 blob "content B" 的哈希（用 node:crypto 而非依赖 hashObject，
 * 避免导入循环或内部 API 依赖）
 */
function blobBHash(): SHA1 {
  const data = Buffer.concat([Buffer.from("blob 9\0"), Buffer.from("content B")]);
  return sha1(createHash("sha1").update(data).digest("hex"));
}

/**
 * 创建包含完整对象集的场景：
 * commit1 → tree1 → blobA, blobB
 *
 * @param store - 对象存储
 * @param writeBlobB - 是否写入 blobB（设为 false 模拟缺失）
 * @returns { commitHash, blobBHash } — commit 哈希和 blobB 的哈希
 */
function buildCommitWithTwoBlobs(
  store: ReturnType<typeof createMemoryObjectStore>,
  writeBlobB: boolean,
): { commitHash: SHA1; blobBHash: SHA1 } {
  const blobA: GitBlob = { type: "blob", content: Buffer.from("content A") };
  const hashA = store.write(blobA);

  const blobBContent = Buffer.from("content B");
  const hashB = blobBHash();
  if (writeBlobB) {
    const blobB: GitBlob = { type: "blob", content: blobBContent };
    store.write(blobB);
  }

  const tree: GitTree = {
    type: "tree",
    entries: [
      { mode: "100644", name: "a.txt", hash: hashA },
      { mode: "100644", name: "b.txt", hash: hashB },
    ],
  };
  const treeHash = store.write(tree);

  const commit: GitCommit = {
    type: "commit",
    tree: treeHash,
    parents: [],
    author: { name: "Test", email: "t@t", timestamp: 1000, timezone: "+0000" },
    committer: { name: "Test", email: "t@t", timestamp: 1000, timezone: "+0000" },
    message: "init",
  };
  const commitHash = store.write(commit);
  return { commitHash, blobBHash: hashB };
}

/**
 * 创建包含完整对象集的场景（无缺失）
 */
function buildCompleteStore() {
  const store = createMemoryObjectStore();
  const { commitHash } = buildCommitWithTwoBlobs(store, true);
  return { store, commitHash };
}

/**
 * 创建 blobB 缺失的场景
 */
function buildMissingBlobStore() {
  const store = createMemoryObjectStore();
  const { commitHash, blobBHash } = buildCommitWithTwoBlobs(store, false);
  return { store, commitHash, blobBHash };
}

// ============================================================================
// collectReachable — throw 模式测试
// ============================================================================

describe('collectReachable(missing="throw")', () => {
  test("所有对象完整时正常收集", () => {
    const { store, commitHash } = buildCompleteStore();
    const result = collectReachable(store, [commitHash], "throw");

    // 应包含 commit + tree + 2 blobs = 4 个对象
    expect(result.size).toBe(4);
    expect(result.has(commitHash)).toBe(true);
  });

  test("根哈希缺失时立即报错", () => {
    const store = createMemoryObjectStore();
    const nonExistentHash = sha1("0000000000000000000000000000000000000001");

    expect(() => {
      collectReachable(store, [nonExistentHash], "throw");
    }).toThrow(PushError);
  });

  test("根哈希缺失时错误信息包含缺失哈希", () => {
    const store = createMemoryObjectStore();
    const nonExistentHash = sha1("0000000000000000000000000000000000000001");

    expect(() => {
      collectReachable(store, [nonExistentHash], "throw");
    }).toThrow(nonExistentHash);
  });

  test("树条目引用的 blob 缺失时报错", () => {
    const { store, commitHash } = buildMissingBlobStore();
    const store2 = store as ReturnType<typeof createMemoryObjectStore>;

    expect(() => {
      collectReachable(store2, [commitHash], "throw");
    }).toThrow(PushError);
  });

  test("树条目引用的 blob 缺失时错误信息包含缺失的 blob 哈希", () => {
    const { store, commitHash, blobBHash } = buildMissingBlobStore();

    expect(() => {
      collectReachable(store, [commitHash], "throw");
    }).toThrow(blobBHash);
  });

  test("多个根哈希，其中一个缺失时报错", () => {
    const { store, commitHash } = buildCompleteStore();
    const nonExistentHash = sha1("0000000000000000000000000000000000000002");

    expect(() => {
      collectReachable(store, [commitHash, nonExistentHash], "throw");
    }).toThrow(PushError);
  });
});

// ============================================================================
// collectReachable — skip 模式（默认）测试
// ============================================================================

describe('collectReachable(missing="skip", 默认)', () => {
  test("所有对象完整时正常收集（与 throw 模式一致）", () => {
    const { store, commitHash } = buildCompleteStore();
    const result = collectReachable(store, [commitHash], "skip");

    expect(result.size).toBe(4);
    expect(result.has(commitHash)).toBe(true);
  });

  test("树条目引用的 blob 缺失时静默跳过", () => {
    const { store, commitHash } = buildMissingBlobStore();
    const result = collectReachable(store, [commitHash], "skip");

    // commit + tree + 只有 blobA → 3 个，blobB 被静默跳过
    expect(result.size).toBe(3);
  });

  test("根哈希缺失时静默跳过，返回空集合", () => {
    const store = createMemoryObjectStore();
    const nonExistentHash = sha1("0000000000000000000000000000000000000001");
    const result = collectReachable(store, [nonExistentHash], "skip");

    expect(result.size).toBe(0);
  });

  test("默认行为为 skip", () => {
    const store = createMemoryObjectStore();
    const nonExistentHash = sha1("0000000000000000000000000000000000000001");
    // 不传 missing 参数，应默认为 "skip" 而非抛出
    const result = collectReachable(store, [nonExistentHash]);
    expect(result.size).toBe(0);
  });

  test("shallow fetch：上游 parent commit 缺失时静默跳过", () => {
    const store = createMemoryObjectStore();
    const emptyTree = store.write({ type: "tree", entries: [] });

    const root: GitCommit = {
      type: "commit",
      tree: emptyTree,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      message: "root",
    };
    const rootHash = store.write(root);

    const a: GitCommit = {
      type: "commit",
      tree: emptyTree,
      parents: [rootHash],
      author: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      message: "a",
    };
    const aHash = store.write(a);

    // b 不写入 store（shallow boundary）
    const bHash = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    // c 的 parent 是 b（不存在于 store）
    const c: GitCommit = {
      type: "commit",
      tree: emptyTree,
      parents: [bHash],
      author: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      message: "c",
    };
    const cHash = store.write(c);

    // skip 模式应静默跳过缺失的 parent b，停止沿该路径回溯；
    // 收集到的是 c + c 的 tree，但不包括 b 上游的对象
    const result = collectReachable(store, [cHash], "skip");

    // 应包含 c 和 emptyTree
    expect(result.has(cHash)).toBe(true);
    expect(result.has(emptyTree)).toBe(true);
    // b 本身不在集合中
    expect(result.has(bHash)).toBe(false);
    // b 上游的 a 和 root 不可达（路径在 b 处截断）
    expect(result.has(aHash)).toBe(false);
    expect(result.has(rootHash)).toBe(false);
  });
});
