/**
 * @deprecated move 语义验证已由 contract/structure.test.ts 覆盖。
 *
 * 保留本文件仅用于验证内部 store 行为。
 */
import { describe, test, expect } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorktreeMemoryStateStore } from "@/worktree/memory-backend.ts";
import { openVirtualWorktree } from "@/worktree/worktree.ts";

describe("move", () => {
  test("纯新增文件 move 后变更记录不膨胀", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const session = openVirtualWorktree(repo.objects, store);

    session.writeFile("a.txt", Buffer.from("data"));
    session.move("a.txt", "b.txt");
    session.move("b.txt", "c.txt");

    expect(store.listChangeRecords()).toHaveLength(1);
    expect(session.diff()).toMatchObject([
      {
        kind: "create",
        path: "c.txt",
        current: {
          kind: "blob",
          mode: "100644",
        },
      },
    ]);
  });
});
