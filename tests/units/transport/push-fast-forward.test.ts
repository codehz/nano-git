/**
 * Push Fast-Forward 预检单元测试
 *
 * 验证 isAncestor（祖先 commit 检查）和 checkFastForward（非强制
 * non-fast-forward 拒绝）的正确行为。
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { sha1, type SHA1, type GitCommit } from "@/core/types.ts";
import { createMemoryObjectStore } from "@/odb/memory-store.ts";
import { isAncestor, checkFastForward, PushError } from "@/transport/push.ts";

// ============================================================================
// 辅助函数
// ============================================================================

const AUTHOR = { name: "T", email: "t@t", timestamp: 1000, timezone: "+0000" };

/**
 * 创建一条 commit 链：root → a → b → c
 *
 * @param store - 对象存储
 * @returns 各 commit 的哈希 { root, a, b, c }
 */
function buildLinearCommits(store: ReturnType<typeof createMemoryObjectStore>) {
  // 需要先写入一个空 tree
  const emptyTreeHash = store.write({ type: "tree", entries: [] });

  const root: GitCommit = {
    type: "commit",
    tree: emptyTreeHash,
    parents: [],
    author: AUTHOR,
    committer: AUTHOR,
    message: "root",
  };
  const rootHash = store.write(root);

  const a: GitCommit = {
    type: "commit",
    tree: emptyTreeHash,
    parents: [rootHash],
    author: AUTHOR,
    committer: AUTHOR,
    message: "a",
  };
  const aHash = store.write(a);

  const b: GitCommit = {
    type: "commit",
    tree: emptyTreeHash,
    parents: [aHash],
    author: AUTHOR,
    committer: AUTHOR,
    message: "b",
  };
  const bHash = store.write(b);

  const c: GitCommit = {
    type: "commit",
    tree: emptyTreeHash,
    parents: [bHash],
    author: AUTHOR,
    committer: AUTHOR,
    message: "c",
  };
  const cHash = store.write(c);

  return { root: rootHash, a: aHash, b: bHash, c: cHash };
}

/**
 * 创建一条分叉链：root → a → b (本地), root → a → d (远程)
 */
function buildDivergentCommits(store: ReturnType<typeof createMemoryObjectStore>) {
  const emptyTreeHash = store.write({ type: "tree", entries: [] });

  const root: GitCommit = {
    type: "commit",
    tree: emptyTreeHash,
    parents: [],
    author: AUTHOR,
    committer: AUTHOR,
    message: "root",
  };
  const rootHash = store.write(root);

  const a: GitCommit = {
    type: "commit",
    tree: emptyTreeHash,
    parents: [rootHash],
    author: AUTHOR,
    committer: AUTHOR,
    message: "a",
  };
  const aHash = store.write(a);

  // 本地分支：a → b
  const b: GitCommit = {
    type: "commit",
    tree: emptyTreeHash,
    parents: [aHash],
    author: AUTHOR,
    committer: AUTHOR,
    message: "b",
  };
  const bHash = store.write(b);

  // 远程分支：a → d（分叉）
  const d: GitCommit = {
    type: "commit",
    tree: emptyTreeHash,
    parents: [aHash],
    author: AUTHOR,
    committer: AUTHOR,
    message: "d",
  };
  const dHash = store.write(d);

  // 从 a 分出的另一个分支
  const e: GitCommit = {
    type: "commit",
    tree: emptyTreeHash,
    parents: [aHash],
    author: AUTHOR,
    committer: AUTHOR,
    message: "e",
  };
  const eHash = store.write(e);

  return { root: rootHash, a: aHash, b: bHash, d: dHash, e: eHash };
}

// ============================================================================
// isAncestor 测试
// ============================================================================

describe("isAncestor()", () => {
  let store: ReturnType<typeof createMemoryObjectStore>;
  let commits: { root: SHA1; a: SHA1; b: SHA1; c: SHA1 };

  beforeEach(() => {
    store = createMemoryObjectStore();
    commits = buildLinearCommits(store);
  });

  test("相同哈希返回 true（fast-forward 平凡情况）", () => {
    expect(isAncestor(store, commits.a, commits.a)).toBe(true);
  });

  test("直接父 commit: old = a, new = b", () => {
    expect(isAncestor(store, commits.a, commits.b)).toBe(true);
  });

  test("祖先 commit: old = root, new = c", () => {
    expect(isAncestor(store, commits.root, commits.c)).toBe(true);
  });

  test("后代不是祖先的祖先: old = b, new = a", () => {
    expect(isAncestor(store, commits.b, commits.a)).toBe(false);
  });

  test("无关的 commit 返回 false", () => {
    expect(isAncestor(store, commits.root, commits.root)).toBe(true);
    const otherStore = createMemoryObjectStore();
    const otherTree = otherStore.write({ type: "tree", entries: [] });
    const other: GitCommit = {
      type: "commit",
      tree: otherTree,
      parents: [],
      author: AUTHOR,
      committer: AUTHOR,
      message: "other",
    };
    const otherHash = otherStore.write(other);

    expect(isAncestor(store, otherHash, commits.c)).toBe(false);
  });

  test("oldHash 是 root, newHash 是 root 返回 true", () => {
    expect(isAncestor(store, commits.root, commits.root)).toBe(true);
  });

  test("不存在的对象返回 false", () => {
    const fake = sha1("0000000000000000000000000000000000000042");
    expect(isAncestor(store, commits.a, fake)).toBe(false);
    expect(isAncestor(store, fake, commits.a)).toBe(false);
  });

  test("shallow fetch：中间 commit 缺失时假定 fast-forward", () => {
    // 模拟 shallow fetch 后本地只有部分 commit 链的场景
    // 链为：root → a，但 a 的后续被截断；实际 remoteHash 在更深的上游
    const shallowStore = createMemoryObjectStore();
    const emptyTree = shallowStore.write({ type: "tree", entries: [] });

    const root: GitCommit = {
      type: "commit",
      tree: emptyTree,
      parents: [],
      author: AUTHOR,
      committer: AUTHOR,
      message: "root",
    };
    const rootHash = shallowStore.write(root);

    const a: GitCommit = {
      type: "commit",
      tree: emptyTree,
      parents: [rootHash],
      author: AUTHOR,
      committer: AUTHOR,
      message: "a",
    };
    const aHash = shallowStore.write(a);

    // b 不写入 store，模拟 shallow boundary
    const bHash = sha1("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    // c 的 parent 是 b（不存在于 store）
    const c: GitCommit = {
      type: "commit",
      tree: emptyTree,
      parents: [bHash],
      author: AUTHOR,
      committer: AUTHOR,
      message: "c",
    };
    const cHash = shallowStore.write(c);

    // 显式传递 shallowBoundaries 告知 bHash 是已知 shallow 边界
    const shallowSet = new Set([bHash]);

    // root 是 c 的祖先，但中间 b 缺失 → 应假定 fast-forward
    expect(isAncestor(shallowStore, rootHash, cHash, shallowSet)).toBe(true);
    // a 同样应假定 fast-forward
    expect(isAncestor(shallowStore, aHash, cHash, shallowSet)).toBe(true);
    // 无关哈希在遇到 shallow boundary（b 缺失）时，因为无法继续回溯确认，
    // 也假定为 fast-forward（让服务端做最终判定）
    const unrelated = sha1("ffffffffffffffffffffffffffffffffffffffff");
    expect(isAncestor(shallowStore, unrelated, cHash, shallowSet)).toBe(true);
  });
});

describe("isAncestor() 分叉场景", () => {
  let store: ReturnType<typeof createMemoryObjectStore>;
  let commits: { root: SHA1; a: SHA1; b: SHA1; d: SHA1; e: SHA1 };

  beforeEach(() => {
    store = createMemoryObjectStore();
    commits = buildDivergentCommits(store);
  });

  test("分叉：远程 d 不是本地 b 的祖先", () => {
    // 远程在 a, 本地在 b（从 a 延续）→ fast-forward
    expect(isAncestor(store, commits.a, commits.b)).toBe(true);
    // 远程在 d, 本地在 b（分叉）→ NOT fast-forward
    expect(isAncestor(store, commits.d, commits.b)).toBe(false);
    // 远程在 b, 本地在 d（分叉）→ NOT fast-forward
    expect(isAncestor(store, commits.b, commits.d)).toBe(false);
  });
});

// ============================================================================
// checkFastForward 测试
// ============================================================================

describe("checkFastForward()", () => {
  let store: ReturnType<typeof createMemoryObjectStore>;
  let commits: { root: SHA1; a: SHA1; b: SHA1; c: SHA1 };

  beforeEach(() => {
    store = createMemoryObjectStore();
    commits = buildLinearCommits(store);
  });

  function makeItem(remoteHash: SHA1 | null, localHash: SHA1 | null, force = false) {
    return {
      localRef: "refs/heads/main",
      remoteRef: "refs/heads/main",
      localHash,
      remoteHash,
      force,
    };
  }

  test("fast-forward 更新不抛错", () => {
    const items = [makeItem(commits.a, commits.c)];
    expect(() => checkFastForward(store, items)).not.toThrow();
  });

  test("相同哈希不抛错", () => {
    const items = [makeItem(commits.a, commits.a)];
    expect(() => checkFastForward(store, items)).not.toThrow();
  });

  test("non-fast-forward 且未设 force 抛 PushError", () => {
    const items = [makeItem(commits.c, commits.a)];
    expect(() => checkFastForward(store, items)).toThrow(PushError);
  });

  test("non-fast-forward 且未设 force 的错误消息包含 ref 名", () => {
    const items = [makeItem(commits.c, commits.a)];
    expect(() => checkFastForward(store, items)).toThrow("refs/heads/main");
  });

  test("non-fast-forward 但设了 force 不抛错", () => {
    const items = [makeItem(commits.c, commits.a, true)];
    expect(() => checkFastForward(store, items)).not.toThrow();
  });

  test("删除操作（localHash === null）总是通过", () => {
    const items = [makeItem(commits.c, null)];
    expect(() => checkFastForward(store, items)).not.toThrow();
  });

  test("新建操作（remoteHash === null）总是通过", () => {
    const items = [makeItem(null, commits.a)];
    expect(() => checkFastForward(store, items)).not.toThrow();
  });

  test("多个更新中一个 non-fast-forward 就报错", () => {
    const items = [
      makeItem(commits.a, commits.b), // fast-forward
      makeItem(commits.c, commits.a), // NOT fast-forward
      makeItem(commits.a, commits.c), // fast-forward
    ];
    expect(() => checkFastForward(store, items)).toThrow(PushError);
  });

  test("多个更新中 force 的 non-fast-forward 不影响其他检查", () => {
    const items = [
      makeItem(commits.b, commits.a, true), // force, 跳过检查
      makeItem(commits.c, commits.a), // NOT fast-forward, 应报错
    ];
    expect(() => checkFastForward(store, items)).toThrow(PushError);
  });

  test("所有更新都是 force 的 non-fast-forward 不抛错", () => {
    const items = [makeItem(commits.c, commits.a, true), makeItem(commits.b, commits.a, true)];
    expect(() => checkFastForward(store, items)).not.toThrow();
  });
});
