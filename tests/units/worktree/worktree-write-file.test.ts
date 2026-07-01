/**
 * worktree/worktree.ts writeFile / writeLink 操作单元测试
 */
import { describe, test, expect } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import { openVirtualWorktree } from "@/worktree/engine/worktree.ts";
import { createVirtualWorktreeMemoryStateStore } from "@/worktree/store/memory-backend.ts";

import type { VirtualWorktreeStateStore } from "@/worktree/store/state-store.ts";

describe("writeFile", () => {
  test("写入中途失败时回滚到调用前状态", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const inner = createVirtualWorktreeMemoryStateStore(baseTree);
    let failOnSetNode = true;
    const store: VirtualWorktreeStateStore = {
      kind: inner.kind,
      transact<T>(fn: () => T): T {
        return inner.transact(fn);
      },
      readBaseTree(): import("@/types/index.ts").SHA1 {
        return inner.readBaseTree();
      },
      writeBaseTree(nextBaseTree): void {
        inner.writeBaseTree(nextBaseTree);
      },
      getNode(id) {
        return inner.getNode(id);
      },
      setNode(node): void {
        inner.setNode(node);
        if (failOnSetNode) {
          failOnSetNode = false;
          throw new Error("setNode failed");
        }
      },
      deleteNode(id): void {
        inner.deleteNode(id);
      },
      listChangeRecords() {
        return inner.listChangeRecords();
      },
      getChangeRecord(path) {
        return inner.getChangeRecord(path);
      },
      setChangeRecord(record): void {
        inner.setChangeRecord(record);
      },
      deleteChangeRecord(path): void {
        inner.deleteChangeRecord(path);
      },
      reset(nextBaseTree): void {
        inner.reset(nextBaseTree);
      },
    };

    const session = openVirtualWorktree(repo.objects, store);

    expect(() => session.writeFile("broken.txt", Buffer.from("data"))).toThrow(/setNode failed/);
    expect(session.exists("broken.txt")).toBe(false);
    expect(session.diff()).toEqual([]);
    expect(inner.readBaseTree()).toBe(baseTree);
  });
});

// ==================== writeLink ====================

describe("writeLink", () => {});
