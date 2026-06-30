/**
 * worktree/directory-view.ts 目录视图辅助逻辑测试
 *
 * 从原 worktree-path.test.ts 拆分而来，仅保留 directory-view.ts 相关测试。
 */
import { describe, test, expect } from "bun:test";

import { VirtualNotDirectoryError } from "@/core/errors.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import {
  createNamedOriginChildLookup,
  observeDirectoryChildren,
  observeListedDirectoryChild,
  observeNamedDirectoryChild,
  planAffectedDirectoryChildren,
} from "@/worktree/directory-view.ts";
import { createVirtualWorktreeMemoryStateStore } from "@/worktree/memory-backend.ts";
import { getDirectoryChildrenView } from "@/worktree/worktree-path.ts";
import { openVirtualWorktree } from "@/worktree/worktree.ts";

import type { GitTree } from "@/core/types.ts";

function readTree(repo: ReturnType<typeof createMemoryRepository>, hash: string): GitTree {
  const object = repo.catFile(hash as import("@/core/types.ts").SHA1);
  if (object.type !== "tree") {
    throw new Error(`Expected tree, got ${object.type}`);
  }
  return object;
}

describe("planAffectedDirectoryChildren()", () => {
  test("空 origin lookup 仅输出纯新增受影响名字", () => {
    const plan = planAffectedDirectoryChildren(
      createNamedOriginChildLookup([]),
      new Set(["b.txt", "a.txt"]),
    );

    expect(plan).toEqual([
      {
        name: "b.txt",
        originEntry: null,
        shouldCompile: true,
      },
      {
        name: "a.txt",
        originEntry: null,
        shouldCompile: true,
      },
    ]);
  });

  test("保持 origin 顺序并将纯新增受影响名字补到末尾", () => {
    const lookup = createNamedOriginChildLookup([
      { mode: "100644", name: "a.txt", hash: "a".repeat(40) as import("@/core/types.ts").SHA1 },
      { mode: "100644", name: "b.txt", hash: "b".repeat(40) as import("@/core/types.ts").SHA1 },
    ]);
    const firstEntry = lookup.entries[0];
    const secondEntry = lookup.entries[1];
    if (firstEntry === undefined || secondEntry === undefined) {
      throw new Error("Expected lookup entries to exist");
    }

    const plan = planAffectedDirectoryChildren(lookup, new Set(["b.txt", "c.txt"]));

    expect(plan).toEqual([
      {
        name: "a.txt",
        originEntry: firstEntry,
        shouldCompile: false,
      },
      {
        name: "b.txt",
        originEntry: secondEntry,
        shouldCompile: true,
      },
      {
        name: "c.txt",
        originEntry: null,
        shouldCompile: true,
      },
    ]);
  });
});

describe("observeDirectoryChildren()", () => {
  test("非目录节点抛 VirtualNotDirectoryError", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("a"));
    const store = createVirtualWorktreeMemoryStateStore(repo.createTree([]));
    const node = {
      id: "file:standalone" as import("@/worktree/ids.ts").NodeId,
      origin: { kind: "repo-blob" as const, mode: "100644" as const, hash: blobHash },
      state: { kind: "file" as const, mode: "100644" as const },
    };

    expect(() =>
      observeDirectoryChildren(repo.objects, store, node, "a.txt", {
        onDirectoryChild() {
          return 0;
        },
        isLeafChildDirty() {
          return false;
        },
      }),
    ).toThrow(VirtualNotDirectoryError);
  });

  test("同时归纳 overlay 新增和子目录脏项", () => {
    const repo = createMemoryRepository();
    const childBlob = repo.writeBlob(Buffer.from("base"));
    const childTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: childBlob }]);
    const baseTree = repo.createTree([{ mode: "040000", name: "src", hash: childTree }]);
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const session = openVirtualWorktree(repo.objects, store);

    session.writeFile("src/a.txt", Buffer.from("next"));
    session.writeFile("new.txt", Buffer.from("created"));

    const root = store.getNode("root" as import("@/worktree/ids.ts").NodeId);
    if (root === null || root.state.kind !== "directory") {
      throw new Error("Expected root directory node");
    }

    const observed = observeDirectoryChildren(repo.objects, store, root, "", {
      onDirectoryChild(child) {
        // 目录脏检测：递归检查子项是否有 change record
        const childChangeRecords = store
          .listChangeRecords()
          .filter((r) => r.path.startsWith(child.path + "/") || r.path === child.path);
        return childChangeRecords.length;
      },
      isLeafChildDirty(child) {
        return store.getChangeRecord(child.path) !== null;
      },
    });

    expect(Array.from(observed.affectedNames).sort()).toEqual(["new.txt", "src"]);
    expect(observed.dirtyDescendantCount).toBe(1);
  });
});

describe("observeListedDirectoryChild()", () => {
  test("返回当前节点与完整子路径", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("a"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const root = store.getNode("root" as import("@/worktree/ids.ts").NodeId);
    if (root === null || root.state.kind !== "directory") {
      throw new Error("Expected root directory node");
    }

    const child = getDirectoryChildrenView(repo.objects, store, root, "").get("a.txt");
    if (child === undefined) {
      throw new Error("Expected child to exist");
    }

    const observed = observeListedDirectoryChild(store, "", child);

    expect(observed?.name).toBe("a.txt");
    expect(observed?.path).toBe("a.txt");
    expect(observed?.node.state.kind).toBe("file");
  });

  test("节点缺失时返回 null", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("a"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const root = store.getNode("root" as import("@/worktree/ids.ts").NodeId);
    if (root === null || root.state.kind !== "directory") {
      throw new Error("Expected root directory node");
    }

    const child = getDirectoryChildrenView(repo.objects, store, root, "").get("a.txt");
    if (child === undefined) {
      throw new Error("Expected child to exist");
    }

    store.deleteNode(child.nodeId);

    expect(observeListedDirectoryChild(store, "", child)).toBeNull();
  });
});

describe("observeNamedDirectoryChild()", () => {
  test("overlay 绑定的节点缺失时返回 null", () => {
    const repo = createMemoryRepository();
    const store = createVirtualWorktreeMemoryStateStore(repo.createTree([]));
    const session = openVirtualWorktree(repo.objects, store);

    session.writeFile("a.txt", Buffer.from("a"));
    const root = store.getNode("root" as import("@/worktree/ids.ts").NodeId);
    if (root === null || root.state.kind !== "directory") {
      throw new Error("Expected root directory node");
    }
    const nodeId = root.state.overlay.addedEntries.get("a.txt");
    if (nodeId === undefined) {
      throw new Error("Expected a.txt node");
    }
    store.deleteNode(nodeId);

    expect(
      observeNamedDirectoryChild(store, root, "", createNamedOriginChildLookup([]), "a.txt"),
    ).toBeNull();
  });

  test("目录节点被 tombstone 后返回 null", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("a"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const session = openVirtualWorktree(repo.objects, store);
    session.delete("a.txt");
    const root = store.getNode("root" as import("@/worktree/ids.ts").NodeId);
    if (root === null || root.state.kind !== "directory") {
      throw new Error("Expected root directory node");
    }

    const tree = readTree(repo, baseTree);
    expect(
      observeNamedDirectoryChild(
        store,
        root,
        "",
        createNamedOriginChildLookup(tree.entries),
        "a.txt",
      ),
    ).toBeNull();
  });

  test("按名称返回当前节点与完整子路径", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("a"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const root = store.getNode("root" as import("@/worktree/ids.ts").NodeId);
    if (root === null || root.state.kind !== "directory") {
      throw new Error("Expected root directory node");
    }

    const tree = readTree(repo, baseTree);
    const observed = observeNamedDirectoryChild(
      store,
      root,
      "",
      createNamedOriginChildLookup(tree.entries),
      "a.txt",
    );

    expect(observed?.name).toBe("a.txt");
    expect(observed?.path).toBe("a.txt");
    expect(observed?.node.state.kind).toBe("file");
  });

  test("名称不可见时返回 null", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("a"));
    const baseTree = repo.createTree([{ mode: "100644", name: "a.txt", hash: blobHash }]);
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const root = store.getNode("root" as import("@/worktree/ids.ts").NodeId);
    if (root === null || root.state.kind !== "directory") {
      throw new Error("Expected root directory node");
    }

    const tree = readTree(repo, baseTree);
    expect(
      observeNamedDirectoryChild(
        store,
        root,
        "",
        createNamedOriginChildLookup(tree.entries),
        "missing.txt",
      ),
    ).toBeNull();
  });

  test("传入非目录节点时返回 null", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("a"));
    const node = {
      id: "file:standalone" as import("@/worktree/ids.ts").NodeId,
      origin: { kind: "repo-blob" as const, mode: "100644" as const, hash: blobHash },
      state: { kind: "file" as const, mode: "100644" as const },
    };
    const store = createVirtualWorktreeMemoryStateStore(repo.createTree([]));

    expect(
      observeNamedDirectoryChild(store, node, "", createNamedOriginChildLookup([]), "a.txt"),
    ).toBeNull();
  });
});
