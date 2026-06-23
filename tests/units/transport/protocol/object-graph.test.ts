/**
 * transport/protocol/object-graph.ts 单元测试
 *
 * 覆盖 collectReachable / isAncestor / peelTagChain
 */

import { describe, test, expect } from "bun:test";

import { ObjectNotFoundError } from "@/core/errors.ts";
import { sha1 } from "@/core/types.ts";
import { writeObject } from "@/objects/raw.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";
import { collectReachable, isAncestor, peelTagChain } from "@/transport/protocol/object-graph.ts";

import type { SHA1 } from "@/core/types.ts";

function makeCommit(
  store: ReturnType<typeof createMemoryObjectStore>,
  tree: SHA1,
  parents: SHA1[],
): SHA1 {
  return writeObject(store, {
    type: "commit",
    tree,
    parents,
    author: { name: "A", email: "a@a", timestamp: 0, timezone: "+0000" },
    committer: { name: "A", email: "a@a", timestamp: 0, timezone: "+0000" },
    message: "msg",
  });
}

function makeBlob(store: ReturnType<typeof createMemoryObjectStore>, content: string): SHA1 {
  return writeObject(store, { type: "blob", content: Buffer.from(content) });
}

function makeTree(
  store: ReturnType<typeof createMemoryObjectStore>,
  entries: Array<{ mode: string; name: string; hash: SHA1 }>,
): SHA1 {
  return writeObject(store, { type: "tree", entries });
}

function makeTag(store: ReturnType<typeof createMemoryObjectStore>, target: SHA1): SHA1 {
  return writeObject(store, {
    type: "tag",
    object: target,
    objectType: "commit",
    tag: "test-tag",
    tagger: { name: "T", email: "t@t", timestamp: 0, timezone: "+0000" },
    message: "tag message",
  });
}

// ============================================================================
// peelTagChain
// ============================================================================

describe("peelTagChain()", () => {
  test("非 tag 对象返回自身", () => {
    const store = createMemoryObjectStore();
    const blob = makeBlob(store, "hello");
    expect(peelTagChain(store, blob)).toBe(blob);
  });

  test("单层 tag 解引用到目标", () => {
    const store = createMemoryObjectStore();
    const blob = makeBlob(store, "hello");
    const tag = makeTag(store, blob);
    expect(peelTagChain(store, tag)).toBe(blob);
  });

  test("多层 tag 链解引用", () => {
    const store = createMemoryObjectStore();
    const blob = makeBlob(store, "data");
    const tag1 = makeTag(store, blob);
    const tag2 = makeTag(store, tag1);
    expect(peelTagChain(store, tag2)).toBe(blob);
  });

  test("缺失对象返回当前 hash", () => {
    const store = createMemoryObjectStore();
    const missing = sha1("0000000000000000000000000000000000000001");
    expect(peelTagChain(store, missing)).toBe(missing);
  });

  test("浅边界中的缺失对象返回 hash", () => {
    const store = createMemoryObjectStore();
    const missing = sha1("0000000000000000000000000000000000000002");
    const boundaries = new Set<SHA1>([missing]);
    expect(peelTagChain(store, missing, boundaries)).toBe(missing);
  });
});

// ============================================================================
// collectReachable
// ============================================================================

describe("collectReachable()", () => {
  test("blob 可达自身", () => {
    const store = createMemoryObjectStore();
    const blob = makeBlob(store, "hello");
    const result = collectReachable(store, [blob]);
    expect(result.size).toBe(1);
    expect(result.has(blob)).toBe(true);
  });

  test("commit 可达 tree 和 blob", () => {
    const store = createMemoryObjectStore();
    const blob = makeBlob(store, "content");
    const tree = makeTree(store, [{ mode: "100644", name: "f.txt", hash: blob }]);
    const commit = makeCommit(store, tree, []);
    const result = collectReachable(store, [commit]);
    expect(result.has(commit)).toBe(true);
    expect(result.has(tree)).toBe(true);
    expect(result.has(blob)).toBe(true);
  });

  test("缺失对象时 default skip 不抛出", () => {
    const store = createMemoryObjectStore();
    const missing = sha1("0000000000000000000000000000000000000001");
    expect(() => collectReachable(store, [missing])).not.toThrow();
  });

  test("缺失对象时 throw 模式抛出 ObjectNotFoundError", () => {
    const store = createMemoryObjectStore();
    const missing = sha1("0000000000000000000000000000000000000001");
    expect(() => collectReachable(store, [missing], "throw")).toThrow(ObjectNotFoundError);
  });

  test("多个根节点的可达集合并集", () => {
    const store = createMemoryObjectStore();
    const b1 = makeBlob(store, "a");
    const b2 = makeBlob(store, "b");
    const result = collectReachable(store, [b1, b2]);
    expect(result.size).toBe(2);
    expect(result.has(b1)).toBe(true);
    expect(result.has(b2)).toBe(true);
  });

  test("tag 直达 blob", () => {
    const store = createMemoryObjectStore();
    const blob = makeBlob(store, "data");
    const tag = makeTag(store, blob);
    const result = collectReachable(store, [tag]);
    expect(result.has(tag)).toBe(true);
    expect(result.has(blob)).toBe(true);
  });

  test("共享对象不重复计数", () => {
    const store = createMemoryObjectStore();
    const blob = makeBlob(store, "shared");
    const t1 = makeTree(store, [{ mode: "100644", name: "f", hash: blob }]);
    const t2 = makeTree(store, [{ mode: "100644", name: "g", hash: blob }]);
    const c1 = makeCommit(store, t1, []);
    const c2 = makeCommit(store, t2, [c1]);
    const result = collectReachable(store, [c2]);
    // 对象图: c2 → t2, c2 → c1, c1 → t1, t1 → blob, t2 → blob
    // 共享 blob 只应计一次，共 5 个唯一对象
    expect(result.size).toBe(5);
    expect(result.has(blob)).toBe(true);
  });
});

// ============================================================================
// isAncestor
// ============================================================================

describe("isAncestor()", () => {
  test("相同哈希是祖先", () => {
    const store = createMemoryObjectStore();
    const blob = makeBlob(store, "x");
    expect(isAncestor(store, blob, blob)).toBe(true);
  });

  test("线性历史：旧 commit 是新 commit 的祖先", () => {
    const store = createMemoryObjectStore();
    const blob = makeBlob(store, "c");
    const tree = makeTree(store, [{ mode: "100644", name: "f", hash: blob }]);
    const oldCommit = makeCommit(store, tree, []);
    const newCommit = makeCommit(store, tree, [oldCommit]);
    expect(isAncestor(store, oldCommit, newCommit)).toBe(true);
  });

  test("线性历史：新 commit 不是旧 commit 的祖先", () => {
    const store = createMemoryObjectStore();
    const blob = makeBlob(store, "c");
    const tree = makeTree(store, [{ mode: "100644", name: "f", hash: blob }]);
    const oldCommit = makeCommit(store, tree, []);
    const newCommit = makeCommit(store, tree, [oldCommit]);
    expect(isAncestor(store, newCommit, oldCommit)).toBe(false);
  });

  test("不相关分支返回 false", () => {
    const store = createMemoryObjectStore();
    const b1 = makeBlob(store, "a");
    const b2 = makeBlob(store, "b");
    const t1 = makeTree(store, [{ mode: "100644", name: "a", hash: b1 }]);
    const t2 = makeTree(store, [{ mode: "100644", name: "b", hash: b2 }]);
    const c1 = makeCommit(store, t1, []);
    const c2 = makeCommit(store, t2, []);
    expect(isAncestor(store, c1, c2)).toBe(false);
    expect(isAncestor(store, c2, c1)).toBe(false);
  });

  test("合并提交的祖先检测", () => {
    const store = createMemoryObjectStore();
    const blob = makeBlob(store, "base");
    const tree = makeTree(store, [{ mode: "100644", name: "f", hash: blob }]);
    const base = makeCommit(store, tree, []);
    const branch1 = makeCommit(store, tree, [base]);
    const branch2 = makeCommit(store, tree, [base]);
    const merge = makeCommit(store, tree, [branch1, branch2]);
    expect(isAncestor(store, base, merge)).toBe(true);
    expect(isAncestor(store, branch1, merge)).toBe(true);
    expect(isAncestor(store, branch2, merge)).toBe(true);
  });

  test("缺失对象返回 false", () => {
    const store = createMemoryObjectStore();
    const missing = sha1("0000000000000000000000000000000000000001");
    const real = makeBlob(store, "real");
    expect(isAncestor(store, missing, real)).toBe(false);
  });

  test("tag 解引用后祖先检测", () => {
    const store = createMemoryObjectStore();
    const blob = makeBlob(store, "x");
    const tree = makeTree(store, [{ mode: "100644", name: "f", hash: blob }]);
    const oldCommit = makeCommit(store, tree, []);
    const newCommit = makeCommit(store, tree, [oldCommit]);
    const tag = makeTag(store, newCommit);
    // tag 解引用到 newCommit，所以 oldCommit 是 tag 的祖先
    expect(isAncestor(store, oldCommit, tag)).toBe(true);
  });
});
