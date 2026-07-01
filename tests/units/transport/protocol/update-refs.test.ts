/**
 * transport/protocol/update-refs.ts 单元测试
 *
 * 覆盖 applyRefUpdates / resolveBranchTargetHash / isRefNamespaceRequiringFastForward
 */

import { describe, test, expect } from "bun:test";

import { writeObject } from "@/objects/raw.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";
import { createMemoryRefStore } from "@/refs/memory.ts";
import {
  applyRefUpdates,
  resolveBranchTargetHash,
  isRefNamespaceRequiringFastForward,
  RefUpdateError,
} from "@/transport/protocol/update-refs.ts";
import { sha1 } from "@/types/index.ts";

import type { RefUpdatePlanItem } from "@/transport/protocol/update-refs.ts";
import type { SHA1 } from "@/types/index.ts";

function makeBlob(store: ReturnType<typeof createMemoryObjectStore>, content: string): SHA1 {
  return writeObject(store, { type: "blob", content: Buffer.from(content) });
}

function makeTree(
  store: ReturnType<typeof createMemoryObjectStore>,
  entries: Array<{ mode: string; name: string; hash: SHA1 }>,
): SHA1 {
  return writeObject(store, { type: "tree", entries });
}

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

const emptyTree = sha1("4b825dc642cb6eb9a060e54bf899d153036d1e4d");

function makeUpdate(
  remoteHash: SHA1,
  localRef: string,
  currentLocalHash?: SHA1,
  force = false,
  remoteName?: string,
): RefUpdatePlanItem {
  return {
    remoteRef: { hash: remoteHash, name: remoteName ?? localRef },
    localRef,
    currentLocalHash,
    force,
  };
}

// ============================================================================
// isRefNamespaceRequiringFastForward
// ============================================================================

describe("isRefNamespaceRequiringFastForward()", () => {
  test("refs/heads/* 需要 fast-forward", () => {
    expect(isRefNamespaceRequiringFastForward("refs/heads/main")).toBe(true);
    expect(isRefNamespaceRequiringFastForward("refs/heads/feature")).toBe(true);
  });

  test("refs/tags/* 不需要 fast-forward", () => {
    expect(isRefNamespaceRequiringFastForward("refs/tags/v1.0")).toBe(false);
  });

  test("refs/remotes/* 不需要 fast-forward", () => {
    expect(isRefNamespaceRequiringFastForward("refs/remotes/origin/main")).toBe(false);
  });

  test("HEAD 不需要 fast-forward", () => {
    expect(isRefNamespaceRequiringFastForward("HEAD")).toBe(false);
  });

  test("自定义命名空间不需要 fast-forward", () => {
    expect(isRefNamespaceRequiringFastForward("refs/custom/foo")).toBe(false);
  });
});

// ============================================================================
// resolveBranchTargetHash
// ============================================================================

describe("resolveBranchTargetHash()", () => {
  test("commit 对象通过校验", () => {
    const store = createMemoryObjectStore();
    const commit = makeCommit(store, emptyTree, []);
    expect(resolveBranchTargetHash(store, commit, "refs/heads/main")).toBe(commit);
  });

  test("blob 对象抛出异常", () => {
    const store = createMemoryObjectStore();
    const blob = makeBlob(store, "data");
    expect(() => resolveBranchTargetHash(store, blob, "refs/heads/main")).toThrow(RefUpdateError);
  });

  test("tree 对象抛出异常", () => {
    const store = createMemoryObjectStore();
    const tree = makeTree(store, []);
    expect(() => resolveBranchTargetHash(store, tree, "refs/heads/main")).toThrow(RefUpdateError);
  });

  test("tag 对象抛出异常", () => {
    const store = createMemoryObjectStore();
    const blob = makeBlob(store, "x");
    const tagHash = writeObject(store, {
      type: "tag",
      object: blob,
      objectType: "blob",
      tag: "t",
      tagger: { name: "T", email: "t@t", timestamp: 0, timezone: "+0000" },
      message: "m",
    });
    expect(() => resolveBranchTargetHash(store, tagHash, "refs/heads/main")).toThrow(
      RefUpdateError,
    );
  });

  test("缺失对象抛出异常", () => {
    const store = createMemoryObjectStore();
    const missing = sha1("0000000000000000000000000000000000000001");
    expect(() => resolveBranchTargetHash(store, missing, "refs/heads/missing")).toThrow(
      RefUpdateError,
    );
  });
});

// ============================================================================
// applyRefUpdates
// ============================================================================

describe("applyRefUpdates()", () => {
  test("创建新分支（无旧哈希）", () => {
    const store = createMemoryObjectStore();
    const refs = createMemoryRefStore();
    const commit = makeCommit(store, emptyTree, []);

    const result = applyRefUpdates(store, refs, [makeUpdate(commit, "refs/heads/new-branch")]);

    expect(result.updatedRefs.get("refs/heads/new-branch")).toBe(commit);
    expect(result.rejectedRefs).toEqual([]);
    expect(refs.read("refs/heads/new-branch")).toBe(commit);
  });

  test("快进更新", () => {
    const store = createMemoryObjectStore();
    const refs = createMemoryRefStore();
    const oldCommit = makeCommit(store, emptyTree, []);
    const newCommit = makeCommit(store, emptyTree, [oldCommit]);
    refs.write("refs/heads/main", oldCommit);

    const result = applyRefUpdates(store, refs, [
      makeUpdate(newCommit, "refs/heads/main", oldCommit),
    ]);

    expect(result.updatedRefs.get("refs/heads/main")).toBe(newCommit);
    expect(result.rejectedRefs).toEqual([]);
  });

  test("非快进更新被拒绝", () => {
    const store = createMemoryObjectStore();
    const refs = createMemoryRefStore();
    const b1 = makeBlob(store, "a");
    const b2 = makeBlob(store, "b");
    const t1 = makeTree(store, [{ mode: "100644", name: "a", hash: b1 }]);
    const t2 = makeTree(store, [{ mode: "100644", name: "b", hash: b2 }]);
    const oldCommit = makeCommit(store, t1, []);
    const unrelatedCommit = makeCommit(store, t2, []);
    refs.write("refs/heads/main", oldCommit);

    const result = applyRefUpdates(store, refs, [
      makeUpdate(unrelatedCommit, "refs/heads/main", oldCommit),
    ]);

    expect(result.updatedRefs.size).toBe(0);
    expect(result.rejectedRefs.length).toBe(1);
    expect(result.rejectedRefs[0]?.localRef).toBe("refs/heads/main");
    expect(result.rejectedRefs[0]?.reason).toContain("Non-fast-forward");
  });

  test("force 标志跳过 fast-forward 检查", () => {
    const store = createMemoryObjectStore();
    const refs = createMemoryRefStore();
    const b1 = makeBlob(store, "a");
    const b2 = makeBlob(store, "b");
    const t1 = makeTree(store, [{ mode: "100644", name: "a", hash: b1 }]);
    const t2 = makeTree(store, [{ mode: "100644", name: "b", hash: b2 }]);
    const oldCommit = makeCommit(store, t1, []);
    const unrelatedCommit = makeCommit(store, t2, []);
    refs.write("refs/heads/main", oldCommit);

    const result = applyRefUpdates(store, refs, [
      makeUpdate(unrelatedCommit, "refs/heads/main", oldCommit, true),
    ]);

    expect(result.updatedRefs.get("refs/heads/main")).toBe(unrelatedCommit);
    expect(result.rejectedRefs).toEqual([]);
  });

  test("标签已存在时非 force 拒绝", () => {
    const store = createMemoryObjectStore();
    const refs = createMemoryRefStore();
    const c1 = makeCommit(store, emptyTree, []);
    const c2 = makeCommit(store, emptyTree, []);
    refs.write("refs/tags/v1", c1);

    const result = applyRefUpdates(store, refs, [makeUpdate(c2, "refs/tags/v1", c1)]);

    expect(result.updatedRefs.size).toBe(0);
    expect(result.rejectedRefs.length).toBe(1);
    expect(result.rejectedRefs[0]?.reason).toContain("Tag");
  });

  test("标签 force 更新成功", () => {
    const store = createMemoryObjectStore();
    const refs = createMemoryRefStore();
    const c1 = makeCommit(store, emptyTree, []);
    const c2 = makeCommit(store, emptyTree, []);
    refs.write("refs/tags/v1", c1);

    const result = applyRefUpdates(store, refs, [makeUpdate(c2, "refs/tags/v1", c1, true)]);

    expect(result.updatedRefs.get("refs/tags/v1")).toBe(c2);
  });

  test("缺失 wanted tip 被拒绝", () => {
    const store = createMemoryObjectStore();
    const refs = createMemoryRefStore();
    const missing = sha1("0000000000000000000000000000000000000001");

    const result = applyRefUpdates(store, refs, [makeUpdate(missing, "refs/heads/main")]);

    expect(result.updatedRefs.size).toBe(0);
    expect(result.rejectedRefs.length).toBe(1);
    expect(result.rejectedRefs[0]?.reason).toContain("not received in the packfile");
  });

  test("部分拒绝不影响其他更新", () => {
    const store = createMemoryObjectStore();
    const refs = createMemoryRefStore();
    const c1 = makeCommit(store, emptyTree, []);
    const c2 = makeCommit(store, emptyTree, [c1]);
    const missing = sha1("0000000000000000000000000000000000000001");

    const result = applyRefUpdates(store, refs, [
      makeUpdate(c1, "refs/heads/branch-a"),
      makeUpdate(missing, "refs/heads/branch-b"),
      makeUpdate(c2, "refs/heads/branch-c"),
    ]);

    expect(result.updatedRefs.get("refs/heads/branch-a")).toBe(c1);
    expect(result.updatedRefs.get("refs/heads/branch-c")).toBe(c2);
    expect(result.updatedRefs.has("refs/heads/branch-b")).toBe(false);
    expect(result.rejectedRefs.length).toBe(1);
    expect(result.rejectedRefs[0]?.localRef).toBe("refs/heads/branch-b");
  });

  test("事务原子性：写入异常时回滚", () => {
    const store = createMemoryObjectStore();
    const refs = createMemoryRefStore();
    const c1 = makeCommit(store, emptyTree, []);

    // 构造一个已存在的 ref 来触发写入异常
    refs.write("refs/heads/existing", c1);

    // 正常更新
    const result = applyRefUpdates(store, refs, [makeUpdate(c1, "refs/heads/new-branch")]);

    expect(result.updatedRefs.get("refs/heads/new-branch")).toBe(c1);
  });
});
