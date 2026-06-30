/**
 * worktree/change-index-plan.ts 刷新策略测试
 */
import { describe, expect, test } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import { createChangeIndexPlanner } from "@/worktree/change-index-plan.ts";
import { createVirtualWorktreeMemoryStateStore } from "@/worktree/memory-backend.ts";

describe("createChangeIndexPlanner()", () => {
  test("缺失路径是否允许增量刷新取决于 treatMissingAsIncremental", () => {
    const repo = createMemoryRepository();
    const store = createVirtualWorktreeMemoryStateStore(repo.createTree([]));
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
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const planner = createChangeIndexPlanner(repo.objects, store, createNoopActions());

    expect(planner.planRefreshForPath("src")).toEqual({ kind: "rebuild-all" });
  });

  test("删除目录时保持全量重建策略", () => {
    const repo = createMemoryRepository();
    const fileHash = repo.writeBlob(Buffer.from("a"));
    const childTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: fileHash }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: childTree }]);
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const planner = createChangeIndexPlanner(repo.objects, store, createNoopActions());

    expect(planner.planDeletePath("src", { treatMissingAsIncremental: true })).toEqual({
      kind: "rebuild-all",
    });
  });

  test("从目录复制会回退到全量重建", () => {
    const repo = createMemoryRepository();
    const fileHash = repo.writeBlob(Buffer.from("a"));
    const childTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: fileHash }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: childTree }]);
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const planner = createChangeIndexPlanner(repo.objects, store, createNoopActions());

    expect(planner.planCopy("src", "copy")).toEqual({ kind: "rebuild-all" });
  });

  test("apply() 会分派到对应动作", () => {
    const repo = createMemoryRepository();
    const store = createVirtualWorktreeMemoryStateStore(repo.createTree([]));
    const calls: string[] = [];
    const planner = createChangeIndexPlanner(repo.objects, store, {
      rebuildAll() {
        calls.push("rebuild-all");
      },
      refreshPath(path) {
        calls.push(`refresh:${path}`);
      },
    });

    planner.apply({ kind: "rebuild-all" });
    planner.apply({ kind: "refresh-path", path: "a.txt" });
    planner.apply(planner.planDeletePath("missing.txt", { treatMissingAsIncremental: true }));

    expect(calls).toEqual(["rebuild-all", "refresh:a.txt", "refresh:missing.txt"]);
  });
});

function createNoopActions() {
  return {
    rebuildAll() {},
    refreshPath() {},
  };
}
