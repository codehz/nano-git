/**
 * merge/session.ts + build-tree + planCommitMerge 单元测试
 */

import { describe, test, expect } from "bun:test";

import { bytes, bytesToUtf8 } from "../../helpers/bytes.ts";
import { MergeBaseError, MergeError, UnresolvedConflictsError } from "@/errors.ts";
import { planCommitMerge } from "@/merge/commit-merge.ts";
import { createMergeSession } from "@/merge/session.ts";
import { planTreeMerge } from "@/merge/three-way.ts";
import { writeObject, readObject } from "@/objects/raw.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";
import { diffTrees } from "@/repository/tree/tree-diff.ts";

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
): SHA1 {
  return writeObject(store, {
    type: "commit",
    tree,
    parents,
    author,
    committer: author,
    message: message.endsWith("\n") ? message : `${message}\n`,
  });
}

describe("createMergeSession() clean / FF", () => {
  test("fast-forward finalize 直接返回 theirs tree", () => {
    const store = createMemoryObjectStore();
    const baseBlob = writeBlob(store, "base");
    const theirsBlob = writeBlob(store, "theirs");
    const base = writeTree(store, [{ mode: "100644", name: "f.txt", hash: baseBlob }]);
    const theirs = writeTree(store, [{ mode: "100644", name: "f.txt", hash: theirsBlob }]);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: base,
      theirsTree: theirs,
    });
    expect(plan.status).toBe("fast-forward");

    const session = createMergeSession(store, plan);
    expect(session.isComplete()).toBe(true);
    const result = session.finalize();
    expect(result.tree).toBe(theirs);
    expect(result.writtenTrees).toEqual([]);
  });

  test("clean 两侧改不同文件 → finalize tree 正确", () => {
    const store = createMemoryObjectStore();
    const a0 = writeBlob(store, "a0");
    const b0 = writeBlob(store, "b0");
    const a1 = writeBlob(store, "a1");
    const b1 = writeBlob(store, "b1");

    const base = writeTree(store, [
      { mode: "100644", name: "a.txt", hash: a0 },
      { mode: "100644", name: "b.txt", hash: b0 },
    ]);
    const ours = writeTree(store, [
      { mode: "100644", name: "a.txt", hash: a1 },
      { mode: "100644", name: "b.txt", hash: b0 },
    ]);
    const theirs = writeTree(store, [
      { mode: "100644", name: "a.txt", hash: a0 },
      { mode: "100644", name: "b.txt", hash: b1 },
    ]);
    const expected = writeTree(store, [
      { mode: "100644", name: "a.txt", hash: a1 },
      { mode: "100644", name: "b.txt", hash: b1 },
    ]);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    expect(plan.status).toBe("clean");

    const { tree } = createMergeSession(store, plan).finalize();
    expect(tree).toBe(expected);
    expect(diffTrees(store, tree, expected)).toEqual([]);
  });

  test("全部 resolve ours → 结果等于 oursTree", () => {
    const store = createMemoryObjectStore();
    const baseBlob = writeBlob(store, "base");
    const oursBlob = writeBlob(store, "ours");
    const theirsBlob = writeBlob(store, "theirs");
    const other = writeBlob(store, "other");

    const base = writeTree(store, [
      { mode: "100644", name: "conflict.txt", hash: baseBlob },
      { mode: "100644", name: "only-ours.txt", hash: other },
    ]);
    const ours = writeTree(store, [
      { mode: "100644", name: "conflict.txt", hash: oursBlob },
      { mode: "100644", name: "only-ours.txt", hash: other },
    ]);
    const theirs = writeTree(store, [
      { mode: "100644", name: "conflict.txt", hash: theirsBlob },
      { mode: "100644", name: "only-ours.txt", hash: other },
    ]);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    expect(plan.status).toBe("conflicted");

    const session = createMergeSession(store, plan);
    session.resolve("conflict.txt", { take: "ours" });
    const { tree } = session.finalize();
    expect(tree).toBe(ours);
  });

  test("全部 resolve theirs → 结果等于 theirsTree", () => {
    const store = createMemoryObjectStore();
    const baseBlob = writeBlob(store, "base");
    const oursBlob = writeBlob(store, "ours");
    const theirsBlob = writeBlob(store, "theirs");

    const base = writeTree(store, [{ mode: "100644", name: "f.txt", hash: baseBlob }]);
    const ours = writeTree(store, [{ mode: "100644", name: "f.txt", hash: oursBlob }]);
    const theirs = writeTree(store, [{ mode: "100644", name: "f.txt", hash: theirsBlob }]);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    const session = createMergeSession(store, plan);
    session.resolve("f.txt", { take: "theirs" });
    expect(session.finalize().tree).toBe(theirs);
  });
});

describe("createMergeSession() 冲突决议", () => {
  test("未 resolve 时 finalize 抛 UnresolvedConflictsError", () => {
    const store = createMemoryObjectStore();
    const baseBlob = writeBlob(store, "base");
    const oursBlob = writeBlob(store, "ours");
    const theirsBlob = writeBlob(store, "theirs");
    const base = writeTree(store, [{ mode: "100644", name: "f.txt", hash: baseBlob }]);
    const ours = writeTree(store, [{ mode: "100644", name: "f.txt", hash: oursBlob }]);
    const theirs = writeTree(store, [{ mode: "100644", name: "f.txt", hash: theirsBlob }]);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    const session = createMergeSession(store, plan);
    expect(session.isComplete()).toBe(false);
    expect(() => session.finalize()).toThrow(UnresolvedConflictsError);
  });

  test("resolve base / custom content / unresolve", () => {
    const store = createMemoryObjectStore();
    const baseBlob = writeBlob(store, "base");
    const oursBlob = writeBlob(store, "ours");
    const theirsBlob = writeBlob(store, "theirs");
    const base = writeTree(store, [{ mode: "100644", name: "f.txt", hash: baseBlob }]);
    const ours = writeTree(store, [{ mode: "100644", name: "f.txt", hash: oursBlob }]);
    const theirs = writeTree(store, [{ mode: "100644", name: "f.txt", hash: theirsBlob }]);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    const session = createMergeSession(store, plan);

    session.resolve("f.txt", { take: "base" });
    expect(session.isComplete()).toBe(true);
    expect(session.finalize().tree).toBe(base);

    session.unresolve("f.txt");
    expect(session.isComplete()).toBe(false);

    session.resolve("f.txt", {
      take: "custom",
      mode: "100644",
      content: bytes("merged!"),
    });
    const { tree } = session.finalize();
    const obj = readObject(store, tree);
    expect(obj.type).toBe("tree");
    if (obj.type === "tree") {
      expect(obj.entries).toHaveLength(1);
      const blob = readObject(store, obj.entries[0]!.hash);
      expect(blob.type).toBe("blob");
      if (blob.type === "blob") {
        expect(bytesToUtf8(blob.content)).toBe("merged!");
      }
    }
  });

  test("modify-delete 取删除侧", () => {
    const store = createMemoryObjectStore();
    const baseBlob = writeBlob(store, "base");
    const oursBlob = writeBlob(store, "ours");
    const base = writeTree(store, [{ mode: "100644", name: "f.txt", hash: baseBlob }]);
    const ours = writeTree(store, [{ mode: "100644", name: "f.txt", hash: oursBlob }]);
    const theirs = writeTree(store, []);

    const plan = planTreeMerge(store, {
      baseTree: base,
      oursTree: ours,
      theirsTree: theirs,
    });
    const session = createMergeSession(store, plan);
    // take theirs → 删除
    session.resolve("f.txt", { take: "theirs" });
    expect(session.finalize().tree).toBe(theirs);
  });

  test("add-add 不能 take base", () => {
    const store = createMemoryObjectStore();
    const empty = writeTree(store, []);
    const oursBlob = writeBlob(store, "ours");
    const theirsBlob = writeBlob(store, "theirs");
    const ours = writeTree(store, [{ mode: "100644", name: "n.txt", hash: oursBlob }]);
    const theirs = writeTree(store, [{ mode: "100644", name: "n.txt", hash: theirsBlob }]);

    const plan = planTreeMerge(store, {
      baseTree: empty,
      oursTree: ours,
      theirsTree: theirs,
    });
    const session = createMergeSession(store, plan);
    expect(() => session.resolve("n.txt", { take: "base" })).toThrow(MergeError);
  });

  test("未知路径 resolve 抛错", () => {
    const store = createMemoryObjectStore();
    const tree = writeTree(store, []);
    const plan = planTreeMerge(store, {
      baseTree: tree,
      oursTree: tree,
      theirsTree: tree,
    });
    const session = createMergeSession(store, plan);
    expect(() => session.resolve("nope.txt", { take: "ours" })).toThrow(MergeError);
  });
});

describe("planCommitMerge()", () => {
  test("自动找 base 并产出 clean plan", () => {
    const store = createMemoryObjectStore();
    const a0 = writeBlob(store, "a0");
    const b0 = writeBlob(store, "b0");
    const a1 = writeBlob(store, "a1");
    const b1 = writeBlob(store, "b1");

    const baseTree = writeTree(store, [
      { mode: "100644", name: "a.txt", hash: a0 },
      { mode: "100644", name: "b.txt", hash: b0 },
    ]);
    const oursTree = writeTree(store, [
      { mode: "100644", name: "a.txt", hash: a1 },
      { mode: "100644", name: "b.txt", hash: b0 },
    ]);
    const theirsTree = writeTree(store, [
      { mode: "100644", name: "a.txt", hash: a0 },
      { mode: "100644", name: "b.txt", hash: b1 },
    ]);

    const base = writeCommit(store, baseTree, [], "base");
    const ours = writeCommit(store, oursTree, [base], "ours");
    const theirs = writeCommit(store, theirsTree, [base], "theirs");

    const plan = planCommitMerge(store, { ours, theirs });
    expect(plan.bases).toEqual([base]);
    expect(plan.oursCommit).toBe(ours);
    expect(plan.theirsCommit).toBe(theirs);
    expect(plan.status).toBe("clean");

    const expected = writeTree(store, [
      { mode: "100644", name: "a.txt", hash: a1 },
      { mode: "100644", name: "b.txt", hash: b1 },
    ]);
    const { tree } = createMergeSession(store, plan).finalize();
    expect(tree).toBe(expected);

    // 调用方写 merge commit
    const merge = writeCommit(store, tree, [ours, theirs], "Merge branch");
    const mergeObj = readObject(store, merge);
    expect(mergeObj.type).toBe("commit");
    if (mergeObj.type === "commit") {
      expect(mergeObj.parents).toEqual([ours, theirs]);
      expect(mergeObj.tree).toBe(tree);
    }
  });

  test("无关历史抛 MergeBaseError", () => {
    const store = createMemoryObjectStore();
    const tree = writeTree(store, []);
    const a = writeCommit(store, tree, [], "a");
    const b = writeCommit(store, tree, [], "b");

    expect(() => planCommitMerge(store, { ours: a, theirs: b })).toThrow(MergeBaseError);
  });
});
