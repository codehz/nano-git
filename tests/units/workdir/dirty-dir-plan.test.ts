/**
 * workdir/dirty-dir-plan.ts 脏目录摘要策略测试
 */
import { describe, expect, test } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import { createDirtyDirPlanner } from "@/workdir/dirty-dir-plan.ts";
import { createVirtualWorkdirMemoryStateStore } from "@/workdir/memory-backend.ts";
import { openVirtualWorkdir } from "@/workdir/workdir.ts";

describe("createDirtyDirPlanner()", () => {
  test("clear() 会清空全部 dirty dir summaries", () => {
    const repo = createMemoryRepository();
    const store = createVirtualWorkdirMemoryStateStore(repo.createTree([]));
    const session = openVirtualWorkdir(repo.objects, store);
    const planner = createDirtyDirPlanner(repo.objects, store);

    session.mkdir("src");
    session.writeFile("src/a.ts", Buffer.from("next"));
    expect(store.listDirtyDirSummaries().length).toBeGreaterThan(0);

    planner.clear();

    expect(store.listDirtyDirSummaries()).toEqual([]);
  });

  test("rebuild() 会删除已经收敛为 clean 的摘要", () => {
    const repo = createMemoryRepository();
    const store = createVirtualWorkdirMemoryStateStore(repo.createTree([]));
    const session = openVirtualWorkdir(repo.objects, store);
    const planner = createDirtyDirPlanner(repo.objects, store);

    session.mkdir("src");
    session.writeFile("src/a.ts", Buffer.from("next"));
    session.delete("src/a.ts");
    expect(store.listDirtyDirSummaries()).toHaveLength(1);

    planner.rebuild(["src/a.ts"]);

    expect(store.listDirtyDirSummaries()).toEqual([
      {
        path: "",
        isDirty: true,
        dirtyEntryCount: 1,
        dirtyDescendantCount: 0,
        affectedNames: ["src"],
        currentTreeHash: null,
        hashState: "stale",
      },
    ]);
  });

  test("rebuild() 只使受 touchedPaths 影响的目录 hash 失效", () => {
    const repo = createMemoryRepository();
    const aHash = repo.writeBlob(Buffer.from("a"));
    const readmeHash = repo.writeBlob(Buffer.from("readme"));
    const srcTree = repo.createTree([{ mode: "100644", name: "a.ts", hash: aHash }]);
    const docsTree = repo.createTree([{ mode: "100644", name: "readme.md", hash: readmeHash }]);
    const baseTree = repo.createTree([
      { mode: "040000", name: "docs", hash: docsTree },
      { mode: "040000", name: "src", hash: srcTree },
    ]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);
    const session = openVirtualWorkdir(repo.objects, store);
    const planner = createDirtyDirPlanner(repo.objects, store);

    session.writeFile("src/a.ts", Buffer.from("next"));
    session.writeTree();

    const srcSummaryBefore = store.getDirtyDirSummary("src");
    if (srcSummaryBefore === null || srcSummaryBefore.currentTreeHash === null) {
      throw new Error("Expected src summary to be materialized");
    }

    planner.rebuild(["docs/readme.md"]);

    expect(store.getDirtyDirSummary("src")).toEqual(srcSummaryBefore);
    expect(store.getDirtyDirSummary("")).toEqual({
      path: "",
      isDirty: true,
      dirtyEntryCount: 1,
      dirtyDescendantCount: 1,
      affectedNames: ["src"],
      currentTreeHash: null,
      hashState: "stale",
    });
  });
});
