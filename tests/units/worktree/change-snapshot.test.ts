/**
 * worktree/change-snapshot.ts 快照视图测试
 */
import { describe, expect, test } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import {
  getBaseSnapshotView,
  listCurrentSnapshotEntries,
} from "@/worktree/engine/change-snapshot.ts";
import { openVirtualWorktree } from "@/worktree/engine/worktree.ts";
import { createVirtualWorktreeMemoryStateStore } from "@/worktree/store/memory-backend.ts";

describe("change-snapshot", () => {
  test("listCurrentSnapshotEntries() 包含写入后的路径", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const session = openVirtualWorktree(repo.objects, store);

    session.writeFile("hello.txt", Buffer.from("hi"));

    const entries = listCurrentSnapshotEntries(repo.objects, store);
    const hello = entries.find((entry) => entry.path === "hello.txt");

    expect(hello).not.toBeUndefined();
    expect(hello?.object.kind).toBe("blob");
  });

  test("getBaseSnapshotView() 与 baseTree 条目一致", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("base"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorktreeMemoryStateStore(baseTree);

    const view = getBaseSnapshotView(repo.objects, baseTree);
    const entry = view.byPath.get("a.txt");

    expect(entry?.object.hash).toBe(blobHash);
    expect(store.readBaseTree()).toBe(baseTree);
  });
});
