/**
 * Virtual Workdir 持久化 backend 合同测试
 *
 * 用于冻结 file/sqlite backend 的 reopen、deleteSession、
 * listSessions 与 tree hash 一致性语义。
 */
import { describe, expect, test } from "bun:test";

import { createMemoryRepository } from "@/repository/memory.ts";
import { resetNodeIdCounterForTests } from "@/workdir/ids.ts";
import { resetVirtualWorkdirSessionIdCounterForTests } from "@/workdir/session-id.ts";

import type { SHA1 } from "@/core/types.ts";
import type {
  VirtualDiffEntry,
  VirtualWorkdirBackend,
  VirtualWorkdirSessionId,
} from "@/workdir/core.ts";

export interface PersistentVirtualWorkdirBackendInstance {
  /** 当前打开的 backend */
  readonly backend: VirtualWorkdirBackend;
  /** 释放当前 backend 资源 */
  dispose(): void;
}

export interface PersistentVirtualWorkdirBackendHarness {
  /** 打开一个绑定到同一持久化存储的 backend 实例 */
  openBackend(): PersistentVirtualWorkdirBackendInstance;
  /** 主动制造 session 损坏，用于冻结恢复语义 */
  corruptSession(sessionId: VirtualWorkdirSessionId): void;
  /** 清理本次测试用到的持久化存储 */
  cleanup(): void;
}

export type PersistentVirtualWorkdirBackendHarnessFactory =
  () => PersistentVirtualWorkdirBackendHarness;

/**
 * 运行持久化 backend 合同测试
 *
 * @example
 * ```ts
 * runPersistentVirtualWorkdirContract("file", () => ({
 *   openBackend() {
 *     const backend = createFileVirtualWorkdirBackend(root);
 *     return { backend, dispose() {} };
 *   },
 *   corruptSession(sessionId) {
 *     // 修改底层持久化数据，制造不可恢复 session
 *   },
 *   cleanup() {
 *     rmSync(root, { recursive: true, force: true });
 *   },
 * }));
 * ```
 */
export function runPersistentVirtualWorkdirContract(
  name: string,
  createHarness: PersistentVirtualWorkdirBackendHarnessFactory,
): void {
  describe(`VirtualWorkdir persistence contract: ${name}`, () => {
    test("reopen、listSessions、deleteSession 语义稳定", () => {
      resetVirtualWorkdirSessionIdCounterForTests();
      resetNodeIdCounterForTests();
      const repo = createMemoryRepository();
      const harness = createHarness();

      try {
        let sessionId: VirtualWorkdirSessionId;
        {
          const instance = harness.openBackend();
          try {
            sessionId = instance.backend.createSession({ baseTree: repo.createTree([]) });
            const session = instance.backend.openSession(repo.objects, sessionId);
            session.mkdir("dir");
            session.writeFile("dir/a.txt", Buffer.from("alpha"));
            session.writeLink("link", "target");
            expect(instance.backend.listSessions()).toEqual([sessionId]);
          } finally {
            instance.dispose();
          }
        }

        {
          const instance = harness.openBackend();
          try {
            expect(instance.backend.listSessions()).toEqual([sessionId]);
            const session = instance.backend.openSession(repo.objects, sessionId);
            expect(session.readFile("dir/a.txt").toString()).toBe("alpha");
            expect(session.readLink("link")).toBe("target");

            instance.backend.deleteSession(sessionId);
            expect(instance.backend.listSessions()).toEqual([]);
            expect(() => instance.backend.openSession(repo.objects, sessionId)).toThrow(
              /Virtual workdir session not found/,
            );
          } finally {
            instance.dispose();
          }
        }

        {
          const instance = harness.openBackend();
          try {
            expect(instance.backend.listSessions()).toEqual([]);
            expect(() => instance.backend.openSession(repo.objects, sessionId)).toThrow(
              /Virtual workdir session not found/,
            );
          } finally {
            instance.dispose();
          }
        }
      } finally {
        harness.cleanup();
      }
    });

    test("多个 session reopen 后隔离且 writeTree 结果稳定", () => {
      resetVirtualWorkdirSessionIdCounterForTests();
      resetNodeIdCounterForTests();
      const repo = createMemoryRepository();
      const harness = createHarness();

      try {
        let sessionAId: VirtualWorkdirSessionId;
        let sessionBId: VirtualWorkdirSessionId;
        let treeA: SHA1;
        let treeB: SHA1;
        {
          const instance = harness.openBackend();
          try {
            sessionAId = instance.backend.createSession({ baseTree: repo.createTree([]) });
            sessionBId = instance.backend.createSession({ baseTree: repo.createTree([]) });

            const sessionA = instance.backend.openSession(repo.objects, sessionAId);
            sessionA.mkdir("src");
            sessionA.writeFile("src/main.ts", Buffer.from("export const a = 1;\n"));
            treeA = sessionA.writeTree();

            const sessionB = instance.backend.openSession(repo.objects, sessionBId);
            sessionB.writeFile("README.md", Buffer.from("# demo\n"));
            sessionB.writeLink("current", "README.md");
            treeB = sessionB.writeTree();

            expect(instance.backend.listSessions()).toEqual([sessionAId, sessionBId]);
          } finally {
            instance.dispose();
          }
        }

        {
          const instance = harness.openBackend();
          try {
            expect(instance.backend.listSessions()).toEqual([sessionAId, sessionBId]);

            const reopenedA = instance.backend.openSession(repo.objects, sessionAId);
            const reopenedB = instance.backend.openSession(repo.objects, sessionBId);

            expect(reopenedA.readFile("src/main.ts").toString()).toBe("export const a = 1;\n");
            expect(reopenedB.readFile("README.md").toString()).toBe("# demo\n");
            expect(reopenedB.readLink("current")).toBe("README.md");
            expect(reopenedA.exists("README.md")).toBe(false);
            expect(reopenedB.exists("src")).toBe(false);

            expect(reopenedA.writeTree()).toBe(treeA);
            expect(reopenedB.writeTree()).toBe(treeB);
          } finally {
            instance.dispose();
          }
        }
      } finally {
        harness.cleanup();
      }
    });

    test("reopen 后 diff 不依赖进程内缓存", () => {
      resetVirtualWorkdirSessionIdCounterForTests();
      resetNodeIdCounterForTests();
      const repo = createMemoryRepository();
      const harness = createHarness();

      try {
        let sessionId: VirtualWorkdirSessionId;
        let stableDiff: VirtualDiffEntry[];
        {
          const instance = harness.openBackend();
          try {
            sessionId = instance.backend.createSession({ baseTree: repo.createTree([]) });
            const session = instance.backend.openSession(repo.objects, sessionId);
            session.writeFile("a.txt", Buffer.from("alpha"));
            session.writeFile("b.txt", Buffer.from("beta"));

            stableDiff = session.diff();
            expect(session.diff()).toEqual(stableDiff);
          } finally {
            instance.dispose();
          }
        }

        {
          const instance = harness.openBackend();
          try {
            const reopened = instance.backend.openSession(repo.objects, sessionId);
            expect(reopened.diff()).toEqual(stableDiff);

            reopened.writeFile("b.txt", Buffer.from("beta-2"));
            const modifiedDiff = reopened.diff();
            expect(modifiedDiff).not.toEqual(stableDiff);
            expect(reopened.diff()).toEqual(modifiedDiff);
            expect(modifiedDiff.map((entry) => entry.path)).toEqual(["a.txt", "b.txt"]);
            expect(modifiedDiff[0]?.type).toBe("add");
            expect(modifiedDiff[1]?.type).toBe("add");
          } finally {
            instance.dispose();
          }
        }
      } finally {
        harness.cleanup();
      }
    });

    test("删除其中一个 session 后其余 session 仍可 reopen 且 listSessions 保持准确", () => {
      resetVirtualWorkdirSessionIdCounterForTests();
      resetNodeIdCounterForTests();
      const repo = createMemoryRepository();
      const harness = createHarness();

      try {
        let keptSessionId: VirtualWorkdirSessionId;
        let deletedSessionId: VirtualWorkdirSessionId;
        let keptTree: SHA1;
        {
          const instance = harness.openBackend();
          try {
            keptSessionId = instance.backend.createSession({ baseTree: repo.createTree([]) });
            deletedSessionId = instance.backend.createSession({ baseTree: repo.createTree([]) });

            const keptSession = instance.backend.openSession(repo.objects, keptSessionId);
            keptSession.mkdir("pkg");
            keptSession.writeFile("pkg/index.ts", Buffer.from("export const kept = true;\n"));
            keptTree = keptSession.writeTree();

            const deletedSession = instance.backend.openSession(repo.objects, deletedSessionId);
            deletedSession.writeFile("tmp.txt", Buffer.from("remove me"));

            expect(instance.backend.listSessions()).toEqual([keptSessionId, deletedSessionId]);

            instance.backend.deleteSession(deletedSessionId);
            expect(instance.backend.listSessions()).toEqual([keptSessionId]);
            expect(() => instance.backend.openSession(repo.objects, deletedSessionId)).toThrow(
              /Virtual workdir session not found/,
            );
          } finally {
            instance.dispose();
          }
        }

        {
          const instance = harness.openBackend();
          try {
            expect(instance.backend.listSessions()).toEqual([keptSessionId]);

            const keptSession = instance.backend.openSession(repo.objects, keptSessionId);
            expect(keptSession.readFile("pkg/index.ts").toString()).toBe(
              "export const kept = true;\n",
            );
            expect(keptSession.writeTree()).toBe(keptTree);

            expect(() => instance.backend.openSession(repo.objects, deletedSessionId)).toThrow(
              /Virtual workdir session not found/,
            );
          } finally {
            instance.dispose();
          }
        }
      } finally {
        harness.cleanup();
      }
    });

    test("reset 后 reopen 使用新 baseTree 且旧 overlay 被丢弃", () => {
      resetVirtualWorkdirSessionIdCounterForTests();
      resetNodeIdCounterForTests();
      const repo = createMemoryRepository();
      const harness = createHarness();

      const oldBlob = repo.writeBlob(Buffer.from("old\n"));
      const newBlob = repo.writeBlob(Buffer.from("new\n"));
      const keepBlob = repo.writeBlob(Buffer.from("keep\n"));
      const oldBaseTree = repo.createTree([{ mode: "100644", name: "old.txt", hash: oldBlob }]);
      const newBaseTree = repo.createTree([
        { mode: "100644", name: "new.txt", hash: newBlob },
        { mode: "100644", name: "keep.txt", hash: keepBlob },
      ]);

      try {
        let sessionId: VirtualWorkdirSessionId;
        let resetTree: SHA1;
        {
          const instance = harness.openBackend();
          try {
            sessionId = instance.backend.createSession({ baseTree: oldBaseTree });
            const session = instance.backend.openSession(repo.objects, sessionId);

            session.writeFile("draft.txt", Buffer.from("draft"));
            session.reset(newBaseTree);
            session.writeFile("keep.txt", Buffer.from("changed\n"));

            resetTree = session.writeTree();

            expect(session.baseTree).toBe(newBaseTree);
            expect(session.exists("old.txt")).toBe(false);
            expect(session.exists("draft.txt")).toBe(false);
            expect(session.readFile("new.txt").toString()).toBe("new\n");
            expect(session.readFile("keep.txt").toString()).toBe("changed\n");
          } finally {
            instance.dispose();
          }
        }

        {
          const instance = harness.openBackend();
          try {
            const reopened = instance.backend.openSession(repo.objects, sessionId);

            expect(reopened.baseTree).toBe(newBaseTree);
            expect(reopened.exists("old.txt")).toBe(false);
            expect(reopened.exists("draft.txt")).toBe(false);
            expect(reopened.readFile("new.txt").toString()).toBe("new\n");
            expect(reopened.readFile("keep.txt").toString()).toBe("changed\n");
            expect(reopened.writeTree()).toBe(resetTree);
          } finally {
            instance.dispose();
          }
        }
      } finally {
        harness.cleanup();
      }
    });

    test("损坏 session 不出现在 listSessions 且健康 session 仍可恢复", () => {
      resetVirtualWorkdirSessionIdCounterForTests();
      resetNodeIdCounterForTests();
      const repo = createMemoryRepository();
      const harness = createHarness();

      try {
        let healthySessionId: VirtualWorkdirSessionId;
        let brokenSessionId: VirtualWorkdirSessionId;
        {
          const instance = harness.openBackend();
          try {
            healthySessionId = instance.backend.createSession({ baseTree: repo.createTree([]) });
            brokenSessionId = instance.backend.createSession({ baseTree: repo.createTree([]) });

            const healthySession = instance.backend.openSession(repo.objects, healthySessionId);
            healthySession.writeFile("keep.txt", Buffer.from("alive"));

            const brokenSession = instance.backend.openSession(repo.objects, brokenSessionId);
            brokenSession.writeFile("broken.txt", Buffer.from("stale"));

            expect(instance.backend.listSessions()).toEqual([healthySessionId, brokenSessionId]);
          } finally {
            instance.dispose();
          }
        }

        harness.corruptSession(brokenSessionId);

        {
          const instance = harness.openBackend();
          try {
            expect(instance.backend.listSessions()).toEqual([healthySessionId]);

            const healthySession = instance.backend.openSession(repo.objects, healthySessionId);
            expect(healthySession.readFile("keep.txt").toString()).toBe("alive");

            expect(() => instance.backend.openSession(repo.objects, brokenSessionId)).toThrow(
              /corrupted|missing root node|Invalid SQLite workdir session base_tree/,
            );
          } finally {
            instance.dispose();
          }
        }
      } finally {
        harness.cleanup();
      }
    });
  });
}
