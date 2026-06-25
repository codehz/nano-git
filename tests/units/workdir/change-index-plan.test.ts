/**
 * workdir/change-index-plan.ts 刷新策略测试
 */
import { describe, expect, test } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import { createChangeIndexPlanner } from "@/workdir/change-index-plan.ts";
import { createVirtualWorkdirMemoryStateStore } from "@/workdir/memory-backend.ts";
import { openVirtualWorkdir } from "@/workdir/workdir.ts";

describe("createChangeIndexPlanner()", () => {
  test("已有 move/copy 来源的路径会回退到全量重建", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);

    session.move("a.txt", "b.txt");

    const planner = createChangeIndexPlanner(repo.objects, store, createNoopActions());

    expect(planner.planRefreshForPath("b.txt")).toEqual({ kind: "rebuild-all" });
  });

  test("缺失路径是否允许增量刷新取决于 treatMissingAsIncremental", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const planner = createChangeIndexPlanner(repo.objects, store, createNoopActions());

    expect(planner.planRefreshForPath("missing.txt")).toEqual({ kind: "rebuild-all" });
    expect(planner.planRefreshForPath("missing.txt", { treatMissingAsIncremental: true })).toEqual({
      kind: "refresh-path",
      path: "missing.txt",
    });
  });

  test("目录路径不能按单路径增量刷新", () => {
    const repo = createMemoryRepository();
    const fileHash = repo.writeBlob(Buffer.from("a"));
    const childTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: fileHash }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: childTree }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const planner = createChangeIndexPlanner(repo.objects, store, createNoopActions());

    expect(planner.planRefreshForPath("src")).toEqual({ kind: "rebuild-all" });
  });

  test("从目录复制会回退到全量重建", () => {
    const repo = createMemoryRepository();
    const fileHash = repo.writeBlob(Buffer.from("a"));
    const childTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: fileHash }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: childTree }]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const planner = createChangeIndexPlanner(repo.objects, store, createNoopActions());

    expect(planner.planWriteForCopy("src", "copy")).toEqual({ kind: "rebuild-all" });
  });

  test("apply() 会分派到对应动作", () => {
    const repo = createMemoryRepository();
    const store = createVirtualWorkdirMemoryStateStore(repo.createTree([]));
    const calls: string[] = [];
    const planner = createChangeIndexPlanner(repo.objects, store, {
      rebuildAll() {
        calls.push("rebuild-all");
      },
      refreshPath(path) {
        calls.push(`refresh:${path}`);
      },
      rewriteRename(from, to) {
        calls.push(`move:${from}->${to}`);
      },
      writeCopy(from, to) {
        calls.push(`copy:${from}->${to}`);
      },
    });

    planner.apply({ kind: "rebuild-all" });
    planner.apply({ kind: "refresh-path", path: "a.txt" });
    planner.apply({ kind: "rewrite-rename", from: "a.txt", to: "b.txt" });
    planner.apply({ kind: "write-copy", from: "a.txt", to: "c.txt" });

    expect(calls).toEqual([
      "rebuild-all",
      "refresh:a.txt",
      "move:a.txt->b.txt",
      "copy:a.txt->c.txt",
    ]);
  });
});

function createNoopActions() {
  return {
    rebuildAll() {},
    refreshPath() {},
    rewriteRename() {},
    writeCopy() {},
  };
}
