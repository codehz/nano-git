/**
 * workdir/file-backend.ts 生命周期测试
 */
import { describe, test, expect } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPersistentVirtualWorkdirContract } from "./persistence-contract.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { createFileVirtualWorkdirStateStore } from "@/workdir/file-backend.ts";
import { createFileVirtualWorkdirBackend } from "@/workdir/file.ts";
import { VIRTUAL_ROOT_NODE_ID } from "@/workdir/nodes.ts";
import { resetVirtualWorkdirSessionIdCounterForTests } from "@/workdir/session-id.ts";

import type { VirtualWorkdirSessionId } from "@/workdir/core.ts";

function createTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "nano-git-workdir-file-"));
}

function getManifestPath(root: string, sessionId: VirtualWorkdirSessionId): string {
  return join(root, "sessions", encodeURIComponent(sessionId), "manifest.json");
}

function getSessionDir(root: string, sessionId: VirtualWorkdirSessionId): string {
  return join(root, "sessions", encodeURIComponent(sessionId));
}

runPersistentVirtualWorkdirContract("file-backend", () => {
  const root = createTempRoot();
  return {
    openBackend() {
      const backend = createFileVirtualWorkdirBackend(root);
      return {
        backend,
        dispose() {},
      };
    },
    corruptSession(sessionId) {
      const manifestPath = getManifestPath(root, sessionId);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        nodes: Record<string, unknown>;
      };
      const { root: _root, ...nodes } = manifest.nodes;
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          nodes,
        }),
      );
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
});

describe("createFileVirtualWorkdirBackend()", () => {
  test("state store transact 在异常时回滚变更", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();
    const backend = createFileVirtualWorkdirBackend(root);
    const baseTree = repo.createTree([]);
    const sessionId = backend.createSession({ baseTree });
    const store = createFileVirtualWorkdirStateStore(join(root, "sessions"), sessionId);

    try {
      expect(() => {
        store.transact(() => {
          store.writeBaseTree(repo.createTree([]));
          const rootNode = store.getNode(VIRTUAL_ROOT_NODE_ID);
          if (rootNode === null || rootNode.state.kind !== "directory") {
            throw new Error("missing root node");
          }
          store.appendChange({ op: "add", path: "broken.txt" });
          store.setNode({
            id: rootNode.id,
            origin: rootNode.origin,
            state: {
              kind: "directory",
              overlay: {
                addedEntries: new Map([["broken.txt", "node-1" as typeof rootNode.id]]),
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("state store transact 在 payload 已落盘后仍回滚到提交前主视图", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();
    const backend = createFileVirtualWorkdirBackend(root);
    const baseTree = repo.createTree([]);
    const sessionId = backend.createSession({ baseTree });
    const store = createFileVirtualWorkdirStateStore(join(root, "sessions"), sessionId);
    const contentDir = join(getSessionDir(root, sessionId), "content");

    try {
      const initialPayloads = readdirSync(contentDir).sort();

      expect(() => {
        store.transact(() => {
          const rootNode = store.getNode(VIRTUAL_ROOT_NODE_ID);
          if (rootNode === null || rootNode.state.kind !== "directory") {
            throw new Error("missing root node");
          }

          const fileNodeId = "node-1" as typeof rootNode.id;
          store.setNode({
            id: fileNodeId,
            origin: { kind: "none" },
            state: {
              kind: "file",
              mode: "100644",
              content: Buffer.from("broken"),
            },
          });
          store.setNode({
            id: rootNode.id,
            origin: rootNode.origin,
            state: {
              kind: "directory",
              overlay: {
                addedEntries: new Map([["broken.txt", fileNodeId]]),
                deletedNames: new Set(),
              },
            },
          });
          store.appendChange({ op: "add", path: "broken.txt" });
          throw new Error("boom");
        });
      }).toThrow(/boom/);

      expect(store.getNode("node-1" as typeof VIRTUAL_ROOT_NODE_ID)).toBeNull();
      expect(store.listChangeRecords()).toEqual([]);
      expect(readdirSync(contentDir).sort()).toEqual(initialPayloads);

      const reopened = backend.openSession(repo.objects, sessionId);
      expect(reopened.exists("broken.txt")).toBe(false);
      expect(reopened.readdir()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("state store transact 在覆盖已有 payload 后仍恢复旧内容", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();
    const backend = createFileVirtualWorkdirBackend(root);
    const baseTree = repo.createTree([]);
    const sessionId = backend.createSession({ baseTree });
    const session = backend.openSession(repo.objects, sessionId);
    session.writeFile("hello.txt", Buffer.from("world"));
    const store = createFileVirtualWorkdirStateStore(join(root, "sessions"), sessionId);
    const contentDir = join(getSessionDir(root, sessionId), "content");

    try {
      const beforeManifest = readFileSync(getManifestPath(root, sessionId), "utf-8");
      const initialPayloads = readdirSync(contentDir).sort();
      const manifest = JSON.parse(beforeManifest) as {
        nodes: Record<
          string,
          {
            state: {
              kind: string;
            };
          }
        >;
      };
      const fileNodeEntry = Object.entries(manifest.nodes).find(
        ([nodeId, node]) => nodeId !== "root" && node.state.kind === "file",
      );
      if (fileNodeEntry === undefined) {
        throw new Error("expected file node");
      }
      const [fileNodeId] = fileNodeEntry;

      expect(() => {
        store.transact(() => {
          store.setNode({
            id: fileNodeId as typeof VIRTUAL_ROOT_NODE_ID,
            origin: { kind: "none" },
            state: {
              kind: "file",
              mode: "100644",
              content: Buffer.from("edited"),
            },
          });
          throw new Error("boom");
        });
      }).toThrow(/boom/);

      expect(readFileSync(getManifestPath(root, sessionId), "utf-8")).toBe(beforeManifest);
      expect(readdirSync(contentDir).sort()).toEqual(initialPayloads);

      const reopened = backend.openSession(repo.objects, sessionId);
      expect(reopened.readFile("hello.txt").toString()).toBe("world");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("事务回滚后 reopened session 的 writeTree 结果保持提交前稳定", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();
    const backend = createFileVirtualWorkdirBackend(root);
    const baseTree = repo.createTree([]);
    const sessionId = backend.createSession({ baseTree });
    const session = backend.openSession(repo.objects, sessionId);

    session.writeFile("hello.txt", Buffer.from("world"));
    session.mkdir("dir");
    session.writeFile("dir/a.txt", Buffer.from("alpha"));
    const stableTree = session.writeTree();
    const stableChanges = session.listChanges();

    const store = createFileVirtualWorkdirStateStore(join(root, "sessions"), sessionId);

    try {
      const manifest = JSON.parse(readFileSync(getManifestPath(root, sessionId), "utf-8")) as {
        nodes: Record<
          string,
          {
            state: {
              kind: string;
            };
          }
        >;
      };
      const fileNodeEntry = Object.entries(manifest.nodes).find(
        ([nodeId, node]) => nodeId !== "root" && node.state.kind === "file",
      );
      if (fileNodeEntry === undefined) {
        throw new Error("expected file node");
      }
      const [fileNodeId] = fileNodeEntry;

      expect(() => {
        store.transact(() => {
          store.setNode({
            id: fileNodeId as typeof VIRTUAL_ROOT_NODE_ID,
            origin: { kind: "none" },
            state: {
              kind: "file",
              mode: "100644",
              content: Buffer.from("broken"),
            },
          });
          store.appendChange({ op: "modify", path: "dir/a.txt" });
          throw new Error("boom");
        });
      }).toThrow(/boom/);

      const reopened = backend.openSession(repo.objects, sessionId);
      expect(reopened.readFile("hello.txt").toString()).toBe("world");
      expect(reopened.readFile("dir/a.txt").toString()).toBe("alpha");
      expect(reopened.listChanges()).toEqual(stableChanges);
      expect(reopened.writeTree()).toBe(stableTree);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("listSessions 只返回包含 manifest 的 session 目录", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      const backend = createFileVirtualWorkdirBackend(root);
      const sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      const sessionsRoot = join(root, "sessions");
      mkdirSync(join(sessionsRoot, "dangling"), { recursive: true });

      expect(backend.listSessions()).toEqual([sessionId]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("listSessions 会忽略损坏的 session manifest", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      const backend = createFileVirtualWorkdirBackend(root);
      const validSessionId = backend.createSession({ baseTree: repo.createTree([]) });
      const brokenSessionId = backend.createSession({ baseTree: repo.createTree([]) });
      const manifestPath = getManifestPath(root, brokenSessionId);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        nodes: Record<string, unknown>;
      };
      const { root: _root, ...nodes } = manifest.nodes;
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          nodes,
        }),
      );

      expect(backend.listSessions()).toEqual([validSessionId]);
      expect(() => backend.openSession(repo.objects, brokenSessionId)).toThrow(/missing root node/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("残留 txn snapshot 目录不会被识别为 session", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      const backend = createFileVirtualWorkdirBackend(root);
      const sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      const snapshotDir = `${getSessionDir(root, sessionId)}.txn-snapshot`;
      cpSync(getSessionDir(root, sessionId), snapshotDir, { recursive: true });

      expect(backend.listSessions()).toEqual([sessionId]);

      const reopened = backend.openSession(repo.objects, sessionId);
      expect(reopened.readdir()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("孤儿 payload 文件不影响 reopen", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        const backend = createFileVirtualWorkdirBackend(root);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeFile("hello.txt", Buffer.from("world"));
      }

      const contentDir = join(root, "sessions", encodeURIComponent(sessionId), "content");
      writeFileSync(join(contentDir, "orphan.bin"), Buffer.from("unused"));

      {
        const backend = createFileVirtualWorkdirBackend(root);
        const session = backend.openSession(repo.objects, sessionId);
        expect(session.readFile("hello.txt").toString()).toBe("world");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("残留事务临时文件不影响 reopen", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        const backend = createFileVirtualWorkdirBackend(root);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeFile("hello.txt", Buffer.from("world"));
      }

      const sessionDir = getSessionDir(root, sessionId);
      const contentDir = join(sessionDir, "content");
      writeFileSync(join(sessionDir, "manifest.json.tmp"), Buffer.from("{}"));
      writeFileSync(join(contentDir, "dangling.bin.tmp"), Buffer.from("unused"));

      {
        const backend = createFileVirtualWorkdirBackend(root);
        const session = backend.openSession(repo.objects, sessionId);
        expect(session.readFile("hello.txt").toString()).toBe("world");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("manifest version 不匹配时拒绝 openSession", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      const backend = createFileVirtualWorkdirBackend(root);
      const sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      const manifestPath = getManifestPath(root, sessionId);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        formatVersion: number;
      };
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          formatVersion: manifest.formatVersion + 1,
        }),
      );

      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Unsupported virtual workdir file manifest version/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("manifest JSON 损坏时拒绝 openSession", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      const backend = createFileVirtualWorkdirBackend(root);
      const sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      writeFileSync(getManifestPath(root, sessionId), "{bad-json");

      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(/JSON/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("manifest baseTree 类型非法时拒绝 openSession", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      const backend = createFileVirtualWorkdirBackend(root);
      const sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      const manifestPath = getManifestPath(root, sessionId);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        baseTree: string;
      };
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          baseTree: 123,
        }),
      );

      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid virtual workdir manifest baseTree/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("manifest changes 类型非法时拒绝 openSession", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      const backend = createFileVirtualWorkdirBackend(root);
      const sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      const manifestPath = getManifestPath(root, sessionId);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        changes: unknown[];
      };
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          changes: {},
        }),
      );

      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid virtual workdir manifest changes/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("manifest nodes 类型非法时拒绝 openSession", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      const backend = createFileVirtualWorkdirBackend(root);
      const sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      const manifestPath = getManifestPath(root, sessionId);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        nodes: Record<string, unknown>;
      };
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          nodes: [],
        }),
      );

      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid virtual workdir manifest nodes/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("session 缺少根节点时 openSession 报损坏错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      const backend = createFileVirtualWorkdirBackend(root);
      const sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      const manifestPath = getManifestPath(root, sessionId);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        nodes: Record<string, unknown>;
      };
      const { root: _root, ...nodes } = manifest.nodes;
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          nodes,
        }),
      );

      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(/missing root node/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("session 根节点不是目录时 openSession 报损坏错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      const backend = createFileVirtualWorkdirBackend(root);
      const sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      const manifestPath = getManifestPath(root, sessionId);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        nodes: Record<
          string,
          { state: { kind: string; mode?: string; contentRef?: string | null } }
        >;
      };
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          nodes: {
            ...manifest.nodes,
            root: {
              ...manifest.nodes.root,
              state: {
                kind: "file",
                mode: "100644",
                contentRef: null,
              },
            },
          },
        }),
      );

      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /root node is not a directory/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("session 根节点 overlay payload 非法时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      const backend = createFileVirtualWorkdirBackend(root);
      const sessionId = backend.createSession({ baseTree: repo.createTree([]) });
      const manifestPath = getManifestPath(root, sessionId);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        nodes: Record<
          string,
          {
            state: {
              kind: string;
              overlay?: unknown;
            };
          }
        >;
      };
      const rootNode = manifest.nodes.root;
      if (rootNode === undefined) {
        throw new Error("expected root node");
      }
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          nodes: {
            ...manifest.nodes,
            root: {
              ...rootNode,
              state: {
                ...rootNode.state,
                overlay: {
                  addedEntries: {},
                  deletedNames: [],
                },
              },
            },
          },
        }),
      );

      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid file workdir directory overlay payload/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("session 含非法 state kind 节点时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        const backend = createFileVirtualWorkdirBackend(root);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeFile("hello.txt", Buffer.from("world"));
      }

      const manifestPath = getManifestPath(root, sessionId);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        nodes: Record<string, { state: { kind: string } }>;
      };
      const fileNodeEntry = Object.entries(manifest.nodes).find(
        ([nodeId, node]) => nodeId !== "root" && node.state.kind === "file",
      );
      if (fileNodeEntry === undefined) {
        throw new Error("expected file node");
      }
      const [nodeId, fileNode] = fileNodeEntry;
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          nodes: {
            ...manifest.nodes,
            [nodeId]: {
              ...fileNode,
              state: {
                ...fileNode.state,
                kind: "broken",
              },
            },
          },
        }),
      );

      const backend = createFileVirtualWorkdirBackend(root);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid file workdir node state kind/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("session 含非法 origin kind 节点时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        const backend = createFileVirtualWorkdirBackend(root);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeFile("hello.txt", Buffer.from("world"));
      }

      const manifestPath = getManifestPath(root, sessionId);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        nodes: Record<string, { origin: { kind: string } }>;
      };
      const fileNodeEntry = Object.entries(manifest.nodes).find(([nodeId]) => nodeId !== "root");
      if (fileNodeEntry === undefined) {
        throw new Error("expected non-root node");
      }
      const [nodeId, fileNode] = fileNodeEntry;
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          nodes: {
            ...manifest.nodes,
            [nodeId]: {
              ...fileNode,
              origin: {
                ...fileNode.origin,
                kind: "broken",
              },
            },
          },
        }),
      );

      const backend = createFileVirtualWorkdirBackend(root);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid file workdir node origin kind/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("session 含非法 origin mode 节点时 openSession 报解析错误", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      const fileHash = repo.writeBlob(Buffer.from("hello"));
      const baseTree = repo.createTree([{ mode: "100644", name: "file.txt", hash: fileHash }]);
      let sessionId: VirtualWorkdirSessionId;
      {
        const backend = createFileVirtualWorkdirBackend(root);
        sessionId = backend.createSession({ baseTree });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeFile("file.txt", Buffer.from("edited"));
      }

      const backend = createFileVirtualWorkdirBackend(root);
      const manifestPath = getManifestPath(root, sessionId);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        nodes: Record<string, { origin: { kind: string; mode?: string } }>;
      };
      const nodeEntry = Object.entries(manifest.nodes).find(
        ([nodeId, node]) => nodeId !== "root" && node.origin.kind === "repo-blob",
      );
      if (nodeEntry === undefined) {
        throw new Error("expected repo-blob node");
      }
      const [nodeId, node] = nodeEntry;
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          nodes: {
            ...manifest.nodes,
            [nodeId]: {
              ...node,
              origin: {
                ...node.origin,
                mode: "100600",
              },
            },
          },
        }),
      );

      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid file workdir node origin mode/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("manifest 引用缺失 payload 时拒绝 openSession", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        const backend = createFileVirtualWorkdirBackend(root);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeFile("hello.txt", Buffer.from("world"));
      }

      const manifestPath = getManifestPath(root, sessionId);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        nodes: Record<string, { state: { kind: string; contentRef?: string | null } }>;
      };
      const fileNode = Object.values(manifest.nodes).find(
        (node) => node.state.kind === "file" && node.state.contentRef !== null,
      );
      if (fileNode === undefined || fileNode.state.contentRef === undefined) {
        throw new Error("expected file node payload ref");
      }
      const payloadRef = fileNode.state.contentRef;
      if (payloadRef === null) {
        throw new Error("expected non-null file node payload ref");
      }
      unlinkSync(
        join(
          root,
          "sessions",
          encodeURIComponent(sessionId),
          "content",
          `${encodeURIComponent(payloadRef)}.bin`,
        ),
      );

      const backend = createFileVirtualWorkdirBackend(root);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Virtual workdir payload not found/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("file 节点 contentRef 类型非法时拒绝 openSession", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        const backend = createFileVirtualWorkdirBackend(root);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeFile("hello.txt", Buffer.from("world"));
      }

      const manifestPath = getManifestPath(root, sessionId);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        nodes: Record<
          string,
          {
            state: {
              kind: string;
              contentRef?: string | null;
            };
          }
        >;
      };
      const fileNodeEntry = Object.entries(manifest.nodes).find(
        ([nodeId, node]) => nodeId !== "root" && node.state.kind === "file",
      );
      if (fileNodeEntry === undefined) {
        throw new Error("expected file node");
      }
      const [nodeId, fileNode] = fileNodeEntry;
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          nodes: {
            ...manifest.nodes,
            [nodeId]: {
              ...fileNode,
              state: {
                ...fileNode.state,
                contentRef: 123,
              },
            },
          },
        }),
      );

      const backend = createFileVirtualWorkdirBackend(root);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid file workdir node content ref/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("symlink 节点 targetRef 类型非法时拒绝 openSession", () => {
    resetVirtualWorkdirSessionIdCounterForTests();
    const repo = createMemoryRepository();
    const root = createTempRoot();

    try {
      let sessionId: VirtualWorkdirSessionId;
      {
        const backend = createFileVirtualWorkdirBackend(root);
        sessionId = backend.createSession({ baseTree: repo.createTree([]) });
        const session = backend.openSession(repo.objects, sessionId);
        session.writeLink("hello", "world");
      }

      const manifestPath = getManifestPath(root, sessionId);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        nodes: Record<
          string,
          {
            state: {
              kind: string;
              targetRef?: string | null;
            };
          }
        >;
      };
      const symlinkNodeEntry = Object.entries(manifest.nodes).find(
        ([nodeId, node]) => nodeId !== "root" && node.state.kind === "symlink",
      );
      if (symlinkNodeEntry === undefined) {
        throw new Error("expected symlink node");
      }
      const [nodeId, symlinkNode] = symlinkNodeEntry;
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          nodes: {
            ...manifest.nodes,
            [nodeId]: {
              ...symlinkNode,
              state: {
                ...symlinkNode.state,
                targetRef: 123,
              },
            },
          },
        }),
      );

      const backend = createFileVirtualWorkdirBackend(root);
      expect(() => backend.openSession(repo.objects, sessionId)).toThrow(
        /Invalid file workdir node target ref/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
