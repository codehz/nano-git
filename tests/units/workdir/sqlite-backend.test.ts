import { Database } from "bun:sqlite";
/**
 * workdir/sqlite-backend.ts 生命周期测试
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPersistentVirtualWorkdirContract } from "./persistence-contract.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { VIRTUAL_ROOT_NODE_ID } from "@/workdir/nodes.ts";
import { resetVirtualWorkdirSessionIdCounterForTests } from "@/workdir/session-id.ts";
import {
  createSqliteVirtualWorkdirBackend,
  createSqliteVirtualWorkdirStateStore,
} from "@/workdir/sqlite-backend.ts";

import type { VirtualWorkdirSessionId } from "@/workdir/core.ts";

function createTempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "nano-git-workdir-sqlite-"));
  return { dir, path: join(dir, "workdir.sqlite") };
}

runPersistentVirtualWorkdirContract("sqlite-backend", () => {
  const { dir, path } = createTempDbPath();
  return {
    openBackend() {
      const backend = createSqliteVirtualWorkdirBackend(path);
      return {
        backend,
        dispose() {
          backend[Symbol.dispose]();
        },
      };
    },
    corruptSession(sessionId) {
      const db = new Database(path);
      try {
        db.query<void, [string, string]>(
          "DELETE FROM workdir_nodes WHERE session_id = ? AND node_id = ?",
        ).run(sessionId, VIRTUAL_ROOT_NODE_ID);
      } finally {
        db.close();
      }
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

describe("createSqliteVirtualWorkdirBackend()", () => {
  test("state store transact 在异常时回滚变更", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      const baseTree = repo.createTree([]);
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree });
      }

      const db = new Database(path);
      const store = createSqliteVirtualWorkdirStateStore(db, sessionId);

      try {
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
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("schema version 不匹配时拒绝打开 backend", () => {
    const { dir, path } = createTempDbPath();

    try {
      const db = new Database(path);
      try {
        db.run("PRAGMA user_version = 999");
      } finally {
        db.close();
      }

      expect(() => createSqliteVirtualWorkdirBackend(path)).toThrow(
        /Unsupported virtual workdir SQLite schema version/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("schema 不再创建 change log 表", () => {
    const { dir, path } = createTempDbPath();

    try {
      using _backend = createSqliteVirtualWorkdirBackend(path);
      const db = new Database(path);
      try {
        const table = db
          .query<{ name: string } | null, [string]>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get("workdir_changes");
        expect(table).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dispose 后 backend 方法全部拒绝继续使用", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      const backend = createSqliteVirtualWorkdirBackend(path);
      const baseTree = repo.createTree([]);
      const sessionId = backend.createSession({ baseTree });
      backend[Symbol.dispose]();

      expect(() => backend.createSession({ baseTree })).toThrow(
        /SQLite virtual workdir backend is disposed/,
      );
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /SQLite virtual workdir backend is disposed/,
      );
      expect(() => backend.deleteSession(sessionId)).toThrow(
        /SQLite virtual workdir backend is disposed/,
      );
      expect(() => backend.listSessions()).toThrow(/SQLite virtual workdir backend is disposed/);

      expect(() => backend[Symbol.dispose]()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("listSessions 会忽略损坏的 session", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let validSessionId: VirtualWorkdirSessionId;
      let brokenSessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        validSessionId = backend.createSession({ baseTree: repo.createTree([]) });
        brokenSessionId = backend.createSession({ baseTree: repo.createTree([]) });
      }

      const db = new Database(path);
      try {
        db.query<void, [string, string]>(
          "DELETE FROM workdir_nodes WHERE session_id = ? AND node_id = ?",
        ).run(brokenSessionId, VIRTUAL_ROOT_NODE_ID);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(backend.listSessions()).toEqual([validSessionId]);
      expect(() => backend.openSession(repo.objects, brokenSessionId)).toThrow(/missing root node/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session base_tree 类型非法时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      }

      const db = new Database(path);
      try {
        db.run("UPDATE workdir_sessions SET base_tree = 123 WHERE session_id = ?", [sessionId]);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid SQLite workdir session base_tree/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("state store readBaseTree 遇到非法 base_tree 时拒绝读取", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      }

      const db = new Database(path);
      try {
        db.run("UPDATE workdir_sessions SET base_tree = '' WHERE session_id = ?", [sessionId]);
        const store = createSqliteVirtualWorkdirStateStore(db, sessionId);
        expect(() => store.readBaseTree()).toThrow(/Invalid SQLite workdir session base_tree/);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session 缺少根节点时 openSession 报损坏错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      }

      const db = new Database(path);
      try {
        db.query<void, [string, string]>(
          "DELETE FROM workdir_nodes WHERE session_id = ? AND node_id = ?",
        ).run(sessionId, VIRTUAL_ROOT_NODE_ID);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(/missing root node/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session 根节点不是目录时 openSession 报损坏错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      }

      const db = new Database(path);
      try {
        db.query<void, [string, string, string, string]>(
          "UPDATE workdir_nodes SET state_kind = ?, state_mode = ?, directory_overlay = NULL WHERE session_id = ? AND node_id = ?",
        ).run("file", "100644", sessionId, VIRTUAL_ROOT_NODE_ID);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /root node is not a directory/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session 根节点 overlay JSON 损坏时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      }

      const db = new Database(path);
      try {
        db.query<void, [string, string, string]>(
          "UPDATE workdir_nodes SET directory_overlay = ? WHERE session_id = ? AND node_id = ?",
        ).run("{not-json", sessionId, VIRTUAL_ROOT_NODE_ID);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid SQLite workdir directory overlay JSON/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session 根节点 overlay payload 非法时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      }

      const db = new Database(path);
      try {
        db.query<void, [string, string, string]>(
          "UPDATE workdir_nodes SET directory_overlay = ? WHERE session_id = ? AND node_id = ?",
        ).run(
          JSON.stringify({ addedEntries: {}, deletedNames: [] }),
          sessionId,
          VIRTUAL_ROOT_NODE_ID,
        );
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid SQLite workdir directory overlay payload/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session 根节点 overlay 列类型非法时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      }

      const db = new Database(path);
      try {
        db.run(
          "UPDATE workdir_nodes SET directory_overlay = CAST(X'00' AS BLOB) WHERE session_id = ? AND node_id = ?",
          [sessionId, VIRTUAL_ROOT_NODE_ID],
        );
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid SQLite workdir directory overlay column type/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("directory 节点含非法 payload 列时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      }

      const db = new Database(path);
      try {
        db.query<void, [Uint8Array, string, string]>(
          "UPDATE workdir_nodes SET content = ? WHERE session_id = ? AND node_id = ?",
        ).run(Buffer.from("broken"), sessionId, VIRTUAL_ROOT_NODE_ID);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid SQLite workdir directory node payload columns/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session 根节点 origin 缺少 hash 时 openSession 报损坏错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      }

      const db = new Database(path);
      try {
        db.query<void, [string, string, string]>(
          "UPDATE workdir_nodes SET origin_hash = ? WHERE session_id = ? AND node_id = ?",
        ).run(null as never as string, sessionId, VIRTUAL_ROOT_NODE_ID);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /repo-tree origin is missing hash/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session 含非法 state kind 节点时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeFile("hello.txt", Buffer.from("world"));
      }

      const db = new Database(path);
      try {
        const nodeId = db
          .query<{ node_id: string } | null, [string]>(
            "SELECT node_id FROM workdir_nodes WHERE session_id = ? AND node_id <> 'root' LIMIT 1",
          )
          .get(sessionId)?.node_id;
        if (nodeId === undefined) {
          throw new Error("missing non-root node");
        }
        db.query<void, [string, string, string]>(
          "UPDATE workdir_nodes SET state_kind = ? WHERE session_id = ? AND node_id = ?",
        ).run("broken", sessionId, nodeId);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid SQLite workdir node state kind/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session 含非法 origin kind 节点时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeFile("hello.txt", Buffer.from("world"));
      }

      const db = new Database(path);
      try {
        const nodeId = db
          .query<{ node_id: string } | null, [string]>(
            "SELECT node_id FROM workdir_nodes WHERE session_id = ? AND node_id <> 'root' LIMIT 1",
          )
          .get(sessionId)?.node_id;
        if (nodeId === undefined) {
          throw new Error("missing non-root node");
        }
        db.query<void, [string, string, string]>(
          "UPDATE workdir_nodes SET origin_kind = ? WHERE session_id = ? AND node_id = ?",
        ).run("broken", sessionId, nodeId);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid SQLite workdir node origin kind/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session 含非法 state mode 节点时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeFile("hello.txt", Buffer.from("world"));
      }

      const db = new Database(path);
      try {
        const nodeId = db
          .query<{ node_id: string } | null, [string]>(
            "SELECT node_id FROM workdir_nodes WHERE session_id = ? AND node_id <> 'root' LIMIT 1",
          )
          .get(sessionId)?.node_id;
        if (nodeId === undefined) {
          throw new Error("missing non-root node");
        }
        db.query<void, [string, string, string]>(
          "UPDATE workdir_nodes SET state_mode = ? WHERE session_id = ? AND node_id = ?",
        ).run("100600", sessionId, nodeId);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid SQLite workdir node state mode/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session 含非法 symlink state mode 节点时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeLink("current", "README.md");
      }

      const db = new Database(path);
      try {
        const nodeId = db
          .query<{ node_id: string } | null, [string]>(
            "SELECT node_id FROM workdir_nodes WHERE session_id = ? AND state_kind = 'symlink' LIMIT 1",
          )
          .get(sessionId)?.node_id;
        if (nodeId === undefined) {
          throw new Error("missing symlink node");
        }
        db.query<void, [string, string, string]>(
          "UPDATE workdir_nodes SET state_mode = ? WHERE session_id = ? AND node_id = ?",
        ).run("100644", sessionId, nodeId);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid SQLite workdir node state mode/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file 节点含非法 payload 列组合时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeFile("hello.txt", Buffer.from("world"));
      }

      const db = new Database(path);
      try {
        const nodeId = db
          .query<{ node_id: string } | null, [string]>(
            "SELECT node_id FROM workdir_nodes WHERE session_id = ? AND state_kind = 'file' LIMIT 1",
          )
          .get(sessionId)?.node_id;
        if (nodeId === undefined) {
          throw new Error("missing file node");
        }
        db.query<void, [Uint8Array, string, string]>(
          "UPDATE workdir_nodes SET target = ? WHERE session_id = ? AND node_id = ?",
        ).run(Buffer.from("broken"), sessionId, nodeId);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid SQLite workdir file node payload columns/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file 节点 content 列类型非法时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeFile("hello.txt", Buffer.from("world"));
      }

      const db = new Database(path);
      try {
        const nodeId = db
          .query<{ node_id: string } | null, [string]>(
            "SELECT node_id FROM workdir_nodes WHERE session_id = ? AND state_kind = 'file' LIMIT 1",
          )
          .get(sessionId)?.node_id;
        if (nodeId === undefined) {
          throw new Error("missing file node");
        }
        db.run("UPDATE workdir_nodes SET content = 'broken' WHERE session_id = ? AND node_id = ?", [
          sessionId,
          nodeId,
        ]);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid SQLite workdir content column type/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("symlink 节点含非法 payload 列组合时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeLink("current", "README.md");
      }

      const db = new Database(path);
      try {
        const nodeId = db
          .query<{ node_id: string } | null, [string]>(
            "SELECT node_id FROM workdir_nodes WHERE session_id = ? AND state_kind = 'symlink' LIMIT 1",
          )
          .get(sessionId)?.node_id;
        if (nodeId === undefined) {
          throw new Error("missing symlink node");
        }
        db.query<void, [Uint8Array, string, string]>(
          "UPDATE workdir_nodes SET content = ? WHERE session_id = ? AND node_id = ?",
        ).run(Buffer.from("broken"), sessionId, nodeId);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid SQLite workdir symlink node payload columns/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("symlink 节点 target 列类型非法时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeLink("current", "README.md");
      }

      const db = new Database(path);
      try {
        const nodeId = db
          .query<{ node_id: string } | null, [string]>(
            "SELECT node_id FROM workdir_nodes WHERE session_id = ? AND state_kind = 'symlink' LIMIT 1",
          )
          .get(sessionId)?.node_id;
        if (nodeId === undefined) {
          throw new Error("missing symlink node");
        }
        db.run("UPDATE workdir_nodes SET target = 'broken' WHERE session_id = ? AND node_id = ?", [
          sessionId,
          nodeId,
        ]);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid SQLite workdir target column type/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session 含非法 repo-blob origin mode 节点时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const { dir, path } = createTempDbPath();

    try {
      const fileHash = repo.writeBlob(Buffer.from("hello"));
      const baseTree = repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]);
      let sessionId: VirtualWorkdirSessionId;
      {
        using backend = createSqliteVirtualWorkdirBackend(path);
        sessionId = backend.createSession({ baseTree });
        const session = backend.openSession(repo.objects, sessionId);
        expect(session.readFile("file.txt").toString()).toBe("hello");
      }

      const db = new Database(path);
      try {
        const nodeId = db
          .query<{ node_id: string } | null, [string]>(
            "SELECT node_id FROM workdir_nodes WHERE session_id = ? AND node_id <> 'root' LIMIT 1",
          )
          .get(sessionId)?.node_id;
        if (nodeId === undefined) {
          throw new Error("missing repo-backed node");
        }
        db.query<void, [string, string, string]>(
          "UPDATE workdir_nodes SET origin_mode = ? WHERE session_id = ? AND node_id = ?",
        ).run("100600", sessionId, nodeId);
      } finally {
        db.close();
      }

      using backend = createSqliteVirtualWorkdirBackend(path);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid SQLite workdir node origin mode/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
