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
import { createMemoryRefStore } from "@/refs/stores/memory.ts";
import { encodePktLine, encodeFlushPkt } from "@/transport/pkt-line.ts";
import { collectReachable, push, PushError } from "@/transport/push.ts";

import type { RemoteTransport } from "@/transport/types.ts";

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

// ============================================================================
// collectReachable — skip-commit-parents（本地 push 专用）测试
// ============================================================================

describe('collectReachable(missing="skip-commit-parents")', () => {
  test("树条目引用的 blob 缺失时抛出 PushError", () => {
    const { store, commitHash } = buildMissingBlobStore();

    expect(() => {
      collectReachable(store, [commitHash], "skip-commit-parents");
    }).toThrow(PushError);
  });

  test("shallow：仅 commit parent 缺失时静默跳过", () => {
    const store = createMemoryObjectStore();
    const emptyTree = store.write({ type: "tree", entries: [] });

    const bHash = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const c: GitCommit = {
      type: "commit",
      tree: emptyTree,
      parents: [bHash],
      author: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      message: "c",
    };
    const cHash = store.write(c);

    const result = collectReachable(store, [cHash], "skip-commit-parents");
    expect(result.has(cHash)).toBe(true);
    expect(result.has(emptyTree)).toBe(true);
    expect(result.has(bHash)).toBe(false);
  });

  test("推送根 commit 缺失时仍抛出", () => {
    const store = createMemoryObjectStore();
    const missingRoot = sha1("0000000000000000000000000000000000000001");

    expect(() => {
      collectReachable(store, [missingRoot], "skip-commit-parents");
    }).toThrow(PushError);
  });
});

// ============================================================================
// push() 本地损坏检测（mock transport）
// ============================================================================

function createPushMockTransport(
  remoteRefs: Array<{ name: string; hash: SHA1 }>,
  onPost?: (body: Buffer) => void,
): RemoteTransport {
  const reportStatus = Buffer.concat([
    encodePktLine("unpack ok\n"),
    ...remoteRefs.map((r) => encodePktLine(`ok ${r.name}\n`)),
    encodeFlushPkt(),
  ]);

  return {
    getReceivePackRefs: async () => ({
      capabilities: { "report-status": true, "side-band-64k": true },
      refs: remoteRefs,
    }),
    postReceivePack: async (body: Buffer) => {
      onPost?.(body);
      return { data: reportStatus, refUpdates: [], progress: [] };
    },
    getRefAdvertisement: async () => {
      throw new Error("not used");
    },
    postUploadPack: async () => {
      throw new Error("not used");
    },
  };
}

describe("push() 本地对象缺失预检", () => {
  test("tree 引用缺失 blob 时在客户端失败且不发送 receive-pack", async () => {
    const { store, commitHash, blobBHash } = buildMissingBlobStore();
    const refStore = createMemoryRefStore(new Map([["refs/heads/corrupt", commitHash]]));

    let postCalled = false;
    const transport = createPushMockTransport([], () => {
      postCalled = true;
    });

    const pushPromise = push(store, refStore, "dummy", {
      transport,
      refSpecs: ["refs/heads/corrupt:refs/heads/corrupt"],
    });

    expect(pushPromise).rejects.toThrow(/missing from the local store/i);
    expect(postCalled).toBe(false);
    void blobBHash;
  });

  test("shallow 边界：parent commit 缺失时仍可完成 push", async () => {
    const store = createMemoryObjectStore();
    const emptyTree = store.write({ type: "tree", entries: [] });
    const rootHash = store.write({
      type: "commit",
      tree: emptyTree,
      parents: [],
      author: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" },
      message: "root",
    });

    const bHash = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const cHash = store.write({
      type: "commit",
      tree: emptyTree,
      parents: [bHash],
      author: { name: "T", email: "t@t", timestamp: 2000, timezone: "+0000" },
      committer: { name: "T", email: "t@t", timestamp: 2000, timezone: "+0000" },
      message: "c",
    });
    void bHash;

    const refStore = createMemoryRefStore(new Map([["refs/heads/main", cHash]]));
    let postCalled = false;
    const transport = createPushMockTransport([{ name: "refs/heads/main", hash: rootHash }], () => {
      postCalled = true;
    });

    // 传入 shallowBoundaries 告知 push 层 bHash 是已知 shallow 边界
    const result = await push(store, refStore, "dummy", {
      transport,
      refSpecs: ["refs/heads/main:refs/heads/main"],
      shallowBoundaries: [bHash],
    });

    expect(postCalled).toBe(true);
    expect(result.objectCount).toBeGreaterThan(0);
  });

  test("shallow 边界存在时 tree 条目的 BLOB 缺失仍应报错（避免静默生成不完整 pack）", async () => {
    const { store, commitHash, blobBHash } = buildMissingBlobStore();
    const refStore = createMemoryRefStore(new Map([["refs/heads/main", commitHash]]));
    let postCalled = false;
    const transport = createPushMockTransport([], () => {
      postCalled = true;
    });

    // 传入一个无关的 shallowBoundary，当前 bug：代码走 "skip" 分支，
    // 导致缺失 blob 被静默跳过，postReceivePack 被误调用
    const pushPromise = push(store, refStore, "dummy", {
      transport,
      refSpecs: ["refs/heads/main:refs/heads/main"],
      shallowBoundaries: [sha1("0000000000000000000000000000000000000099")],
    });

    // 应抛出 PushError 而非静默发送不完整 pack
    expect(pushPromise).rejects.toBeInstanceOf(PushError);
    // 不应发送 receive-pack 请求
    expect(postCalled).toBe(false);
    void blobBHash;
  });
});
