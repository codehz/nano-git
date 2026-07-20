/**
 * Merge 端到端：两分支历史 → plan/resolve/finalize → 双 parent merge commit
 */

import { describe, test, expect } from "bun:test";

import { planCommitMerge, createMergeSession } from "@/merge/index.ts";
import { createMemoryRepository } from "@/repository/memory.ts";

import type { GitAuthor } from "@/types/index.ts";

const author: GitAuthor = {
  name: "E2E",
  email: "e2e@example.com",
  timestamp: 1_700_000_000,
  timezone: "+0000",
};

describe("merge e2e", () => {
  test("clean merge 后可创建双 parent commit", () => {
    const repo = createMemoryRepository();

    const baseTree = repo.createTree([
      { mode: "100644", name: "a.txt", hash: repo.writeBlob(Buffer.from("a0")) },
      { mode: "100644", name: "b.txt", hash: repo.writeBlob(Buffer.from("b0")) },
    ]);
    const base = repo.createCommit(baseTree, [], "base", author);

    const ours = repo.createCommit(
      repo.createTree([
        { mode: "100644", name: "a.txt", hash: repo.writeBlob(Buffer.from("a1")) },
        { mode: "100644", name: "b.txt", hash: repo.writeBlob(Buffer.from("b0")) },
      ]),
      [base],
      "ours",
      author,
    );

    const theirs = repo.createCommit(
      repo.createTree([
        { mode: "100644", name: "a.txt", hash: repo.writeBlob(Buffer.from("a0")) },
        { mode: "100644", name: "b.txt", hash: repo.writeBlob(Buffer.from("b1")) },
      ]),
      [base],
      "theirs",
      author,
    );

    const plan = planCommitMerge(repo.objects, { ours, theirs });
    expect(plan.status).toBe("clean");
    expect(plan.bases).toEqual([base]);

    const session = createMergeSession(repo.objects, plan);
    expect(session.isComplete()).toBe(true);
    const { tree } = session.finalize();

    const expected = repo.createTree([
      { mode: "100644", name: "a.txt", hash: repo.writeBlob(Buffer.from("a1")) },
      { mode: "100644", name: "b.txt", hash: repo.writeBlob(Buffer.from("b1")) },
    ]);
    expect(tree).toBe(expected);

    const mergeCommit = repo.createCommit(tree, [ours, theirs], "Merge branch", author);
    const obj = repo.catFile(mergeCommit);
    expect(obj.type).toBe("commit");
    if (obj.type === "commit") {
      expect(obj.parents).toEqual([ours, theirs]);
      expect(obj.tree).toBe(tree);
    }
  });

  test("conflicted merge：resolve 后 finalize", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([
      { mode: "100644", name: "f.txt", hash: repo.writeBlob(Buffer.from("base")) },
    ]);
    const base = repo.createCommit(baseTree, [], "base", author);
    const ours = repo.createCommit(
      repo.createTree([
        { mode: "100644", name: "f.txt", hash: repo.writeBlob(Buffer.from("ours")) },
      ]),
      [base],
      "ours",
      author,
    );
    const theirs = repo.createCommit(
      repo.createTree([
        { mode: "100644", name: "f.txt", hash: repo.writeBlob(Buffer.from("theirs")) },
      ]),
      [base],
      "theirs",
      author,
    );

    const plan = planCommitMerge(repo.objects, { ours, theirs });
    expect(plan.status).toBe("conflicted");

    const session = createMergeSession(repo.objects, plan);
    session.resolve("f.txt", {
      take: "custom",
      mode: "100644",
      content: Buffer.from("merged"),
    });
    const { tree } = session.finalize();
    const mergeCommit = repo.createCommit(tree, [ours, theirs], "Merge", author);

    const treeObj = repo.catFile(tree);
    expect(treeObj.type).toBe("tree");
    if (treeObj.type === "tree") {
      const blob = repo.catFile(treeObj.entries[0]!.hash);
      expect(blob.type).toBe("blob");
      if (blob.type === "blob") {
        expect(blob.content.toString()).toBe("merged");
      }
    }

    const commit = repo.catFile(mergeCommit);
    expect(commit.type).toBe("commit");
    if (commit.type === "commit") {
      expect(commit.parents).toHaveLength(2);
    }
  });
});
