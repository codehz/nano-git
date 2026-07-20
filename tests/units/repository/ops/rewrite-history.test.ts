/**
 * rewriteHistory 单元测试
 *
 * 通过 raw ingest 构造 unsorted tree（绕过 serializeTree 排序兜底），
 * 验证历史重写后 tip/对象图符合 Git tree 规范。
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { hashObject } from "@/hash/index.ts";
import { encodeObject, readObject, writeObject } from "@/objects/raw.ts";
import { compareTreeEntries } from "@/objects/tree.ts";
import { createMemoryObjectStore } from "@/odb/memory.ts";
import { createMemoryRefStore } from "@/refs/memory.ts";
import { createMaintenanceRepositoryOperations } from "@/repository/ops/maintenance-operations.ts";
import { rewriteHistory } from "@/repository/ops/rewrite-history.ts";
import { sha1, type GitAuthor, type SHA1, type TreeEntry } from "@/types/index.ts";
import { HEAD_REF, HEADS_PREFIX, TAGS_PREFIX } from "@/types/refs.ts";

const AUTHOR: GitAuthor = {
  name: "Tester",
  email: "t@example.com",
  timestamp: 1_700_000_000,
  timezone: "+0000",
};

function ingestUnsortedTree(
  objects: ReturnType<typeof createMemoryObjectStore>,
  entries: TreeEntry[],
): SHA1 {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const mode = entry.mode === "040000" ? "40000" : entry.mode;
    parts.push(Buffer.from(`${mode} ${entry.name}\0`, "utf-8"));
    parts.push(Buffer.from(entry.hash, "hex"));
  }
  const content = Buffer.concat(parts);
  const hash = hashObject("tree", content);
  objects.ingest({ hash, type: "tree", content });
  return hash;
}

function writeBlob(objects: ReturnType<typeof createMemoryObjectStore>, text: string): SHA1 {
  return writeObject(objects, { type: "blob", content: Buffer.from(text) });
}

function writeCommit(
  objects: ReturnType<typeof createMemoryObjectStore>,
  tree: SHA1,
  parents: SHA1[] = [],
  message = "msg\n",
  extra?: Partial<{ gpgsig: string; mergetag: string[] }>,
): SHA1 {
  return writeObject(objects, {
    type: "commit",
    tree,
    parents,
    author: AUTHOR,
    committer: AUTHOR,
    message,
    gpgsig: extra?.gpgsig,
    mergetag: extra?.mergetag,
  });
}

function assertTreeSorted(
  objects: ReturnType<typeof createMemoryObjectStore>,
  treeHash: SHA1,
): void {
  const obj = readObject(objects, treeHash);
  expect(obj.type).toBe("tree");
  if (obj.type !== "tree") return;
  for (let i = 1; i < obj.entries.length; i++) {
    expect(compareTreeEntries(obj.entries[i - 1]!, obj.entries[i]!)).toBeLessThanOrEqual(0);
  }
  for (const entry of obj.entries) {
    if (entry.mode === "040000") {
      assertTreeSorted(objects, entry.hash);
    }
  }
}

describe("rewriteHistory()", () => {
  let objects: ReturnType<typeof createMemoryObjectStore>;
  let refs: ReturnType<typeof createMemoryRefStore>;

  beforeEach(() => {
    objects = createMemoryObjectStore();
    refs = createMemoryRefStore(new Map([[HEAD_REF, `ref: ${HEADS_PREFIX}main`]]));
  });

  test("修复 unsorted tree 并更新分支 tip", () => {
    const blobOutline = writeBlob(objects, "{}\n");
    const blobBody = writeBlob(objects, "body\n");
    const bodiesTree = writeObject(objects, {
      type: "tree",
      entries: [{ mode: "100644", name: "b.txt", hash: blobBody }],
    });

    // 故意乱序：outline.json 在 bodies 前（Git 要求 bodies/ 在前）
    const badTree = ingestUnsortedTree(objects, [
      { mode: "100644", name: "outline.json", hash: blobOutline },
      { mode: "040000", name: "bodies", hash: bodiesTree },
    ]);
    const oldCommit = writeCommit(objects, badTree);
    refs.write(`${HEADS_PREFIX}main`, oldCommit);

    const result = rewriteHistory(objects, refs);

    expect(result.dryRun).toBe(false);
    expect(result.rewrittenTrees).toBeGreaterThanOrEqual(1);
    expect(result.rewrittenCommits).toBe(1);
    expect(result.updatedRefs).toHaveLength(1);
    expect(result.updatedRefs[0]!.ref).toBe(`${HEADS_PREFIX}main`);
    expect(result.updatedRefs[0]!.oldHash).toBe(oldCommit);

    const newCommitHash = result.updatedRefs[0]!.newHash;
    expect(refs.read(`${HEADS_PREFIX}main`)).toBe(newCommitHash);
    // 符号 HEAD 内容不变
    expect(refs.read(HEAD_REF)).toBe(`ref: ${HEADS_PREFIX}main`);

    const newCommit = readObject(objects, newCommitHash);
    expect(newCommit.type).toBe("commit");
    if (newCommit.type === "commit") {
      assertTreeSorted(objects, newCommit.tree);
      const tree = readObject(objects, newCommit.tree);
      expect(tree.type).toBe("tree");
      if (tree.type === "tree") {
        expect(tree.entries.map((e) => e.name)).toEqual(["bodies", "outline.json"]);
      }
    }
  });

  test("已规范历史：无重写、refs 不变", () => {
    const blob = writeBlob(objects, "ok\n");
    const tree = writeObject(objects, {
      type: "tree",
      entries: [{ mode: "100644", name: "a.txt", hash: blob }],
    });
    const commit = writeCommit(objects, tree);
    refs.write(`${HEADS_PREFIX}main`, commit);

    const result = rewriteHistory(objects, refs);

    expect(result.objectMap).toHaveLength(0);
    expect(result.rewrittenTrees).toBe(0);
    expect(result.rewrittenCommits).toBe(0);
    expect(result.updatedRefs).toHaveLength(0);
    expect(refs.read(`${HEADS_PREFIX}main`)).toBe(commit);
  });

  test("目录斜杠与字节序排序特例", () => {
    const bOutline = writeBlob(objects, "o");
    const bFooTxt = writeBlob(objects, "ft");
    const bFooInner = writeBlob(objects, "fi");
    const bResB = writeBlob(objects, "B");
    const bResA = writeBlob(objects, "a");
    const bBodies = writeBlob(objects, "bd");

    const fooTree = writeObject(objects, {
      type: "tree",
      entries: [{ mode: "100644", name: "x.txt", hash: bFooInner }],
    });
    const bodiesTree = writeObject(objects, {
      type: "tree",
      entries: [{ mode: "100644", name: "b.txt", hash: bBodies }],
    });

    const badTree = ingestUnsortedTree(objects, [
      { mode: "100644", name: "outline.json", hash: bOutline },
      { mode: "100644", name: "res_aso.txt", hash: bResA },
      { mode: "040000", name: "foo", hash: fooTree },
      { mode: "100644", name: "foo.txt", hash: bFooTxt },
      { mode: "040000", name: "bodies", hash: bodiesTree },
      { mode: "100644", name: "res_Bxo.txt", hash: bResB },
    ]);
    const commit = writeCommit(objects, badTree);
    refs.write(`${HEADS_PREFIX}main`, commit);

    const result = rewriteHistory(objects, refs);
    const newCommit = readObject(objects, result.updatedRefs[0]!.newHash);
    expect(newCommit.type).toBe("commit");
    if (newCommit.type === "commit") {
      const tree = readObject(objects, newCommit.tree);
      expect(tree.type).toBe("tree");
      if (tree.type === "tree") {
        expect(tree.entries.map((e) => e.name)).toEqual([
          "bodies",
          "foo.txt",
          "foo",
          "outline.json",
          "res_Bxo.txt",
          "res_aso.txt",
        ]);
      }
    }
  });

  test("merge commit：双 parent 同时映射", () => {
    const blobA = writeBlob(objects, "a");
    const blobB = writeBlob(objects, "b");
    const blobM = writeBlob(objects, "m");

    const badTreeA = ingestUnsortedTree(objects, [
      { mode: "100644", name: "z.txt", hash: blobA },
      { mode: "100644", name: "a.txt", hash: blobA },
    ]);
    const badTreeB = ingestUnsortedTree(objects, [
      { mode: "100644", name: "z.txt", hash: blobB },
      { mode: "100644", name: "b.txt", hash: blobB },
    ]);
    const badTreeM = ingestUnsortedTree(objects, [
      { mode: "100644", name: "z.txt", hash: blobM },
      { mode: "100644", name: "m.txt", hash: blobM },
    ]);

    const parentA = writeCommit(objects, badTreeA, [], "a\n");
    const parentB = writeCommit(objects, badTreeB, [], "b\n");
    const merge = writeCommit(objects, badTreeM, [parentA, parentB], "merge\n");
    refs.write(`${HEADS_PREFIX}main`, merge);

    const result = rewriteHistory(objects, refs);
    expect(result.rewrittenCommits).toBe(3);

    const newMerge = readObject(objects, result.updatedRefs[0]!.newHash);
    expect(newMerge.type).toBe("commit");
    if (newMerge.type === "commit") {
      expect(newMerge.parents).toHaveLength(2);
      expect(newMerge.parents[0]).not.toBe(parentA);
      expect(newMerge.parents[1]).not.toBe(parentB);
      assertTreeSorted(objects, newMerge.tree);
      for (const p of newMerge.parents) {
        const pc = readObject(objects, p);
        expect(pc.type).toBe("commit");
        if (pc.type === "commit") assertTreeSorted(objects, pc.tree);
      }
    }
  });

  test("annotated tag 指向坏 commit 时同步重写", () => {
    const blob = writeBlob(objects, "t");
    const badTree = ingestUnsortedTree(objects, [
      { mode: "100644", name: "z.txt", hash: blob },
      { mode: "100644", name: "a.txt", hash: blob },
    ]);
    const commit = writeCommit(objects, badTree);
    const tagHash = writeObject(objects, {
      type: "tag",
      object: commit,
      objectType: "commit",
      tag: "v1",
      tagger: AUTHOR,
      message: "release\n",
    });
    refs.write(`${HEADS_PREFIX}main`, commit);
    refs.write(`${TAGS_PREFIX}v1`, tagHash);

    const result = rewriteHistory(objects, refs);
    expect(result.rewrittenTags).toBe(1);
    expect(result.updatedRefs.map((u) => u.ref).sort()).toEqual([
      `${HEADS_PREFIX}main`,
      `${TAGS_PREFIX}v1`,
    ]);

    const newTagHash = result.updatedRefs.find((u) => u.ref === `${TAGS_PREFIX}v1`)!.newHash;
    const newTag = readObject(objects, newTagHash);
    expect(newTag.type).toBe("tag");
    if (newTag.type === "tag") {
      expect(newTag.object).not.toBe(commit);
      const c = readObject(objects, newTag.object);
      expect(c.type).toBe("commit");
      if (c.type === "commit") assertTreeSorted(objects, c.tree);
    }
  });

  test("剥离 commit 签名并报告 droppedSignatures", () => {
    const blob = writeBlob(objects, "s");
    // 已排序 tree，仅靠剥离签名触发 commit 重写
    const tree = writeObject(objects, {
      type: "tree",
      entries: [{ mode: "100644", name: "f.txt", hash: blob }],
    });
    const commit = writeCommit(objects, tree, [], "signed\n", {
      gpgsig: "-----BEGIN PGP SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----",
    });
    refs.write(`${HEADS_PREFIX}main`, commit);

    const result = rewriteHistory(objects, refs);
    expect(result.rewrittenCommits).toBe(1);
    expect(result.droppedSignatures).toEqual([{ hash: commit, type: "commit", kind: "gpgsig" }]);

    const newCommit = readObject(objects, result.updatedRefs[0]!.newHash);
    expect(newCommit.type).toBe("commit");
    if (newCommit.type === "commit") {
      expect(newCommit.gpgsig).toBeUndefined();
    }
  });

  test("dryRun：不写入新对象、不改 ref，但映射正确", () => {
    const blob = writeBlob(objects, "d");
    const badTree = ingestUnsortedTree(objects, [
      { mode: "100644", name: "z.txt", hash: blob },
      { mode: "100644", name: "a.txt", hash: blob },
    ]);
    const commit = writeCommit(objects, badTree);
    refs.write(`${HEADS_PREFIX}main`, commit);
    const beforeObjects = new Set(objects.list());

    const result = rewriteHistory(objects, refs, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.rewrittenTrees).toBeGreaterThanOrEqual(1);
    expect(result.rewrittenCommits).toBe(1);
    expect(result.updatedRefs).toHaveLength(1);
    expect(result.updatedRefs[0]!.oldHash).toBe(commit);
    expect(result.updatedRefs[0]!.newHash).not.toBe(commit);

    // ref 未变
    expect(refs.read(`${HEADS_PREFIX}main`)).toBe(commit);
    // 未新增对象
    expect(objects.list().sort()).toEqual([...beforeObjects].sort());

    // 映射中的新哈希应与 encode 一致且尚未存在
    for (const item of result.objectMap) {
      expect(objects.exists(item.oldHash)).toBe(true);
      expect(objects.exists(item.newHash)).toBe(false);
    }
  });

  test("pruneUnreachable：经维护 API 清理旧 tip", () => {
    const blob = writeBlob(objects, "p");
    const badTree = ingestUnsortedTree(objects, [
      { mode: "100644", name: "z.txt", hash: blob },
      { mode: "100644", name: "a.txt", hash: blob },
    ]);
    const oldCommit = writeCommit(objects, badTree);
    refs.write(`${HEADS_PREFIX}main`, oldCommit);

    const ops = createMaintenanceRepositoryOperations(objects, refs, null);
    const result = ops.rewriteHistory({ pruneUnreachable: true });

    expect(result.updatedRefs[0]!.oldHash).toBe(oldCommit);
    expect(objects.exists(oldCommit)).toBe(false);
    expect(objects.exists(badTree)).toBe(false);
    expect(objects.exists(result.updatedRefs[0]!.newHash)).toBe(true);
  });

  test("options.refs 限制作用范围", () => {
    const blob = writeBlob(objects, "x");
    const badTree = ingestUnsortedTree(objects, [
      { mode: "100644", name: "z.txt", hash: blob },
      { mode: "100644", name: "a.txt", hash: blob },
    ]);
    const commitMain = writeCommit(objects, badTree, [], "main\n");
    const commitOther = writeCommit(objects, badTree, [], "other\n");
    refs.write(`${HEADS_PREFIX}main`, commitMain);
    refs.write(`${HEADS_PREFIX}other`, commitOther);

    const result = rewriteHistory(objects, refs, {
      refs: [`${HEADS_PREFIX}main`],
    });

    expect(result.updatedRefs.map((u) => u.ref)).toEqual([`${HEADS_PREFIX}main`]);
    expect(refs.read(`${HEADS_PREFIX}other`)).toBe(commitOther);
    expect(refs.read(`${HEADS_PREFIX}main`)).not.toBe(commitMain);
  });

  test("恒等 tree 的 encode 与 writeObject 路径一致", () => {
    // 回归：确保 rewrite 依赖的 serialize 排序与 hash 稳定
    const blob = writeBlob(objects, "stable");
    const entries: TreeEntry[] = [
      { mode: "100644", name: "b.txt", hash: blob },
      { mode: "100644", name: "a.txt", hash: blob },
    ];
    const viaWrite = writeObject(objects, { type: "tree", entries: [...entries] });
    const viaEncode = encodeObject({ type: "tree", entries: [...entries].reverse() }).hash;
    expect(viaWrite).toBe(viaEncode);
  });
});
