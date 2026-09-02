/**
 * merge/merge-base.ts 单元测试
 */

import { describe, test, expect } from "bun:test";

import { bytes } from "../../helpers/bytes.ts";
import { MergeBaseError } from "@/errors.ts";
import { findMergeBase, findMergeBases } from "@/merge/merge-base.ts";
import { writeObject } from "@/objects/raw.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";

import type { GitAuthor, SHA1 } from "@/types/index.ts";

const author: GitAuthor = {
  name: "Tester",
  email: "test@example.com",
  timestamp: 1_700_000_000,
  timezone: "+0000",
};

function writeBlob(store: ReturnType<typeof createMemoryObjectStore>, text: string): SHA1 {
  return writeObject(store, { type: "blob", content: bytes(text) });
}

function writeTree(
  store: ReturnType<typeof createMemoryObjectStore>,
  entries: { mode: string; name: string; hash: SHA1 }[],
): SHA1 {
  return writeObject(store, { type: "tree", entries });
}

function writeCommit(
  store: ReturnType<typeof createMemoryObjectStore>,
  tree: SHA1,
  parents: SHA1[],
  message: string,
  ts = author.timestamp,
): SHA1 {
  return writeObject(store, {
    type: "commit",
    tree,
    parents,
    author: { ...author, timestamp: ts },
    committer: { ...author, timestamp: ts },
    message: message.endsWith("\n") ? message : `${message}\n`,
  });
}

describe("findMergeBases()", () => {
  test("相同 commit 返回自身", () => {
    const store = createMemoryObjectStore();
    const tree = writeTree(store, []);
    const c = writeCommit(store, tree, [], "root");

    expect(findMergeBases(store, c, c)).toEqual([c]);
  });

  test("线性历史：子 commit 的 base 是祖先", () => {
    const store = createMemoryObjectStore();
    const tree = writeTree(store, []);
    const c0 = writeCommit(store, tree, [], "c0");
    const c1 = writeCommit(store, tree, [c0], "c1");
    const c2 = writeCommit(store, tree, [c1], "c2");

    expect(findMergeBases(store, c0, c2)).toEqual([c0]);
    expect(findMergeBases(store, c2, c0)).toEqual([c0]);
    expect(findMergeBases(store, c1, c2)).toEqual([c1]);
  });

  test("分叉汇合：钻石形状单 base", () => {
    const store = createMemoryObjectStore();
    const tree = writeTree(store, []);
    const base = writeCommit(store, tree, [], "base");
    const ours = writeCommit(store, tree, [base], "ours");
    const theirs = writeCommit(store, tree, [base], "theirs");

    expect(findMergeBases(store, ours, theirs)).toEqual([base]);
  });

  test("无共同祖先返回空数组", () => {
    const store = createMemoryObjectStore();
    const tree = writeTree(store, []);
    const a = writeCommit(store, tree, [], "a");
    const b = writeCommit(store, tree, [], "b");

    expect(findMergeBases(store, a, b)).toEqual([]);
  });

  test("criss-cross：两个 independent merge bases", () => {
    //     base
    //    /    \
    //   A      B
    //    \    /
    //   C      D   （C parents=[A,B], D parents=[A,B]）
    //  merge bases of C,D = {A, B}
    const store = createMemoryObjectStore();
    const tree = writeTree(store, []);
    const base = writeCommit(store, tree, [], "base", 100);
    const a = writeCommit(store, tree, [base], "A", 200);
    const b = writeCommit(store, tree, [base], "B", 300);
    const c = writeCommit(store, tree, [a, b], "C", 400);
    const d = writeCommit(store, tree, [a, b], "D", 500);

    const bases = findMergeBases(store, c, d);
    expect(bases).toHaveLength(2);
    expect(new Set(bases)).toEqual(new Set([a, b]));
    // 不包含被支配的 base
    expect(bases).not.toContain(base);
  });

  test("非 commit 输入抛 MergeBaseError", () => {
    const store = createMemoryObjectStore();
    const blob = writeBlob(store, "hi");
    const tree = writeTree(store, [{ mode: "100644", name: "f", hash: blob }]);
    const commit = writeCommit(store, tree, [], "c");

    expect(() => findMergeBases(store, blob, commit)).toThrow(MergeBaseError);
    expect(() => findMergeBases(store, commit, tree)).toThrow(MergeBaseError);
  });
});

describe("findMergeBase()", () => {
  test("无共同祖先返回 null", () => {
    const store = createMemoryObjectStore();
    const tree = writeTree(store, []);
    const a = writeCommit(store, tree, [], "a");
    const b = writeCommit(store, tree, [], "b");

    expect(findMergeBase(store, a, b)).toBeNull();
  });

  test("单 base 直接返回", () => {
    const store = createMemoryObjectStore();
    const tree = writeTree(store, []);
    const base = writeCommit(store, tree, [], "base");
    const ours = writeCommit(store, tree, [base], "ours");
    const theirs = writeCommit(store, tree, [base], "theirs");

    expect(findMergeBase(store, ours, theirs)).toBe(base);
  });

  test("多 base 默认 throw", () => {
    const store = createMemoryObjectStore();
    const tree = writeTree(store, []);
    const root = writeCommit(store, tree, [], "root", 100);
    const a = writeCommit(store, tree, [root], "A", 200);
    const b = writeCommit(store, tree, [root], "B", 300);
    const c = writeCommit(store, tree, [a, b], "C", 400);
    const d = writeCommit(store, tree, [a, b], "D", 500);

    expect(() => findMergeBase(store, c, d)).toThrow(MergeBaseError);
    try {
      findMergeBase(store, c, d);
    } catch (err) {
      expect(err).toBeInstanceOf(MergeBaseError);
      if (err instanceof MergeBaseError) {
        expect(err.bases).toHaveLength(2);
      }
    }
  });

  test("多 base pick-newest 取较新 committer", () => {
    const store = createMemoryObjectStore();
    const tree = writeTree(store, []);
    const root = writeCommit(store, tree, [], "root", 100);
    const a = writeCommit(store, tree, [root], "A", 200);
    const b = writeCommit(store, tree, [root], "B", 300); // newer
    const c = writeCommit(store, tree, [a, b], "C", 400);
    const d = writeCommit(store, tree, [a, b], "D", 500);

    expect(findMergeBase(store, c, d, { onMultiple: "pick-newest" })).toBe(b);
  });

  test("多 base first 返回排序后第一项", () => {
    const store = createMemoryObjectStore();
    const tree = writeTree(store, []);
    const root = writeCommit(store, tree, [], "root", 100);
    const a = writeCommit(store, tree, [root], "A", 200);
    const b = writeCommit(store, tree, [root], "B", 300);
    const c = writeCommit(store, tree, [a, b], "C", 400);
    const d = writeCommit(store, tree, [a, b], "D", 500);

    const bases = findMergeBases(store, c, d);
    expect(bases.length).toBeGreaterThan(0);
    expect(findMergeBase(store, c, d, { onMultiple: "first" })).toBe(bases[0]!);
  });
});
