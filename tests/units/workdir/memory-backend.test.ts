/**
 * workdir/memory-backend.ts 生命周期测试
 */
import { describe, test, expect } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorkdirMemoryStateStore } from "@/workdir/memory-backend.ts";
import { createMemoryVirtualWorkdirBackend } from "@/workdir/memory.ts";
import { VIRTUAL_ROOT_NODE_ID } from "@/workdir/nodes.ts";
import { resetVirtualWorkdirSessionIdCounterForTests } from "@/workdir/session-id.ts";

describe("createMemoryVirtualWorkdirBackend()", () => {
  test("create/open/list 支持基本 session 生命周期", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const backend = createMemoryVirtualWorkdirBackend();
    const baseTree = repo.createTree([]);

    const sessionId = backend.createSession({ baseTree });
    expect(backend.listSessions()).toEqual([sessionId]);

    const session = backend.openSession(repo.objects, sessionId);
    expect(session.baseTree).toBe(baseTree);
    session.writeFile("hello.txt", Buffer.from("world"));

    const reopened = backend.openSession(repo.objects, sessionId);
    expect(reopened.readFile("hello.txt").toString()).toBe("world");
  });

  test("deleteSession 后不可再次打开", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const backend = createMemoryVirtualWorkdirBackend();
    const sessionId = backend.createSession({ baseTree: repo.createTree([]) });

    backend.deleteSession(sessionId);
    expect(backend.listSessions()).toEqual([]);
    expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
      /Virtual workdir session not found/,
    );
  });

  test("多个 session 互不污染", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const backend = createMemoryVirtualWorkdirBackend();
    const baseTree = repo.createTree([]);

    const sessionA = backend.createSession({ baseTree });
    const sessionB = backend.createSession({ baseTree });

    const a = backend.openSession(repo.objects, sessionA);
    const b = backend.openSession(repo.objects, sessionB);

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
        store.appendChange({ op: "add", path: "broken.txt" });
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
    expect(store.listChangeRecords()).toEqual([]);
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
