/**
 * workdir/memory-backend.ts 内部状态测试
 */
import { describe, test, expect } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdirMemoryStateStore } from "@/workdir/memory-backend.ts";
import { createVirtualWorkdir } from "@/workdir/memory.ts";
import { VIRTUAL_ROOT_NODE_ID } from "@/workdir/nodes.ts";

describe("memory VirtualWorkdir", () => {
  test("多个实例互不污染", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);

    const a = createVirtualWorkdir(repo.objects, { baseTree });
    const b = createVirtualWorkdir(repo.objects, { baseTree });

    a.writeFile("a.txt", Buffer.from("alpha"));
    b.writeFile("b.txt", Buffer.from("beta"));

    expect(a.exists("b.txt")).toBe(false);
    expect(b.exists("a.txt")).toBe(false);
    expect(a.readFile("a.txt").toString()).toBe("alpha");
    expect(b.readFile("b.txt").toString()).toBe("beta");
  });

  test("state store transact 在异常时回滚变更", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorkdirMemoryStateStore(baseTree);

    expect(() => {
      store.transact(() => {
        store.writeBaseTree(repo.createTree([]));
        const root = store.getNode(VIRTUAL_ROOT_NODE_ID);
        if (root === null || root.state.kind !== "directory") {
          throw new Error("missing root node");
        }
        store.setNode({
          id: root.id,
          origin: root.origin,
          state: {
            kind: "directory",
            overlay: {
              addedEntries: new Map([["broken.txt", "node-1" as typeof root.id]]),
              deletedNames: new Set(),
            },
          },
        });
        throw new Error("boom");
      });
    }).toThrow(/boom/);

    expect(store.readBaseTree()).toBe(baseTree);
    expect(store.getNode(VIRTUAL_ROOT_NODE_ID)).toEqual({
      id: VIRTUAL_ROOT_NODE_ID,
      origin: { kind: "repo-tree", hash: baseTree },
      state: {
        kind: "directory",
        overlay: { addedEntries: new Map(), deletedNames: new Set() },
      },
    });
  });
});
