/**
 * @deprecated copy 语义验证已由 contract/structure.test.ts 覆盖。
 *
 * 保留本文件仅用于验证内部 store 行为。
 */
import { describe, test, expect } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import { openVirtualWorktree } from "@/worktree/engine/worktree.ts";
import { createVirtualWorktreeMemoryStateStore } from "@/worktree/store/memory-backend.ts";

describe("copy", () => {
  test("worktree-only copy 产出 create 且不膨胀记录", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const session = openVirtualWorktree(repo.objects, store);

    session.writeFile("a.txt", Buffer.from("data"));
    session.copy("a.txt", "b.txt");

    expect(store.listChangeRecords()).toHaveLength(2);
    expect(session.diff()).toMatchObject([
      {
        kind: "create",
        path: "a.txt",
      },
      {
        kind: "create",
        path: "b.txt",
      },
    ]);
    const copyEntry = session.diff()[1];
    expect(copyEntry?.kind).toBe("create");
  });
});
