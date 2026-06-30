/**
 * worktree/worktree.ts diff 操作单元测试
 */
import { describe, test, expect } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorktree, openVirtualWorktree } from "@/worktree/engine/worktree.ts";
import { createVirtualWorktreeMemoryStateStore } from "@/worktree/store/memory-backend.ts";

describe("diff（写入操作）", () => {
  test("重复修改同一路径时变更记录不膨胀", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const session = openVirtualWorktree(repo.objects, store);

    session.writeFile("f.txt", Buffer.from("v1"));
    session.writeFile("f.txt", Buffer.from("v2"));
    session.writeFile("f.txt", Buffer.from("v3"));

    expect(store.listChangeRecords()).toHaveLength(1);
    expect(session.diff()).toMatchObject([
      {
        kind: "create",
        path: "f.txt",
        current: {
          kind: "blob",
          mode: "100644",
        },
      },
    ]);
  });

  test("删除新增文件时变更记录被清空而不膨胀", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const session = openVirtualWorktree(repo.objects, store);

    session.writeFile("f.txt", Buffer.from("data"));
    expect(store.listChangeRecords()).toHaveLength(1);

    session.delete("f.txt");
    expect(store.listChangeRecords()).toEqual([]);
    expect(session.diff()).toEqual([]);
  });
});
