/**
 * worktree/worktree-transaction.ts 事务与节点辅助测试
 */
import { describe, expect, test } from "bun:test";

import { VirtualOriginUnavailableError } from "@/core/errors.ts";
import { sha1 } from "@/core/types.ts";
import { createMemoryRepository } from "@/repository/memory.ts";
import { createVirtualWorktreeMemoryStateStore } from "@/worktree/memory-backend.ts";
import {
  createNewDirectoryNode,
  createNodeId,
  createRootDirectoryNode,
  VIRTUAL_ROOT_NODE_ID,
} from "@/worktree/nodes.ts";
import { overlayBindEntry } from "@/worktree/overlay.ts";
import {
  cloneNodeGraphForCopy,
  runInWriteTransaction,
  statDirectoryNode,
  statNode,
  updateParentOverlay,
} from "@/worktree/worktree-transaction.ts";
import { openVirtualWorktree } from "@/worktree/worktree.ts";

describe("runInWriteTransaction()", () => {
  test("先执行提交前回调，再执行提交后回调", () => {
    const store = createVirtualWorktreeMemoryStateStore(
      sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"),
    );
    const order: string[] = [];

    const result = runInWriteTransaction(
      store,
      () => {
        order.push("before");
      },
      () => {
        order.push("after");
      },
      () => {
        order.push("body");
        return 42;
      },
    );

    expect(result).toBe(42);
    expect(order).toEqual(["body", "before", "after"]);
  });

  test("提交前回调为 null 时仍会执行提交后回调", () => {
    const store = createVirtualWorktreeMemoryStateStore(
      sha1("95d09f2b10159347eece71399a7e2e907ea3df4f"),
    );
    const order: string[] = [];

    runInWriteTransaction(
      store,
      null,
      () => {
        order.push("after");
      },
      () => {
        order.push("body");
      },
    );

    expect(order).toEqual(["body", "after"]);
  });

  test("主体抛错时由 state store 回滚且不触发提交后回调", () => {
    const baseTree = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const before = store.readBaseTree();
    let committed = false;

    expect(() =>
      runInWriteTransaction(
        store,
        () => {
          throw new Error("commit failed");
        },
        () => {
          committed = true;
        },
        () => {
          store.writeBaseTree(sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        },
      ),
    ).toThrow("commit failed");

    expect(store.readBaseTree()).toBe(before);
    expect(committed).toBe(false);
  });
});

describe("updateParentOverlay()", () => {
  test("用新 overlay 覆盖父目录节点", () => {
    const tree = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const store = createVirtualWorktreeMemoryStateStore(tree);
    const root = store.getNode(VIRTUAL_ROOT_NODE_ID);
    if (root === null || root.state.kind !== "directory") {
      throw new Error("Expected root directory node");
    }

    const childId = createNodeId();
    const overlay = overlayBindEntry(root.state.overlay, "a.txt", childId);
    updateParentOverlay(store, VIRTUAL_ROOT_NODE_ID, overlay);

    const updated = store.getNode(VIRTUAL_ROOT_NODE_ID);
    if (updated === null || updated.state.kind !== "directory") {
      throw new Error("Expected updated root directory node");
    }
    expect(updated.state.overlay.addedEntries.get("a.txt")).toBe(childId);
  });

  test("父节点不是目录时抛错", () => {
    const tree = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const store = createVirtualWorktreeMemoryStateStore(tree);
    const fileId = createNodeId();
    store.setNode({
      id: fileId,
      origin: { kind: "none" },
      state: { kind: "file", mode: "100644", content: Buffer.from("x") },
    });

    expect(() => updateParentOverlay(store, fileId, rootOverlay(tree))).toThrow(
      "updateParentOverlay: parent is not a directory",
    );
  });
});

describe("statNode()", () => {
  test("repo-backed 文件未 materialize 时从 origin 读取 size/hash", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("hello"));
    const node = {
      id: createNodeId(),
      origin: { kind: "repo-blob" as const, mode: "100644" as const, hash: blobHash },
      state: { kind: "file" as const, mode: "100644" as const },
    };

    expect(statNode(repo.objects, node, "a.txt")).toEqual({
      kind: "blob",
      mode: "100644",
      size: 5,
      hash: blobHash,
    });
  });

  test("repo-backed 符号链接未 materialize 时从 origin 读取 size/hash", () => {
    const repo = createMemoryRepository();
    const linkHash = repo.writeBlob(Buffer.from("target/path"));
    const node = {
      id: createNodeId(),
      origin: { kind: "repo-blob" as const, mode: "120000" as const, hash: linkHash },
      state: { kind: "symlink" as const, mode: "120000" as const },
    };

    expect(statNode(repo.objects, node, "link")).toEqual({
      kind: "symlink",
      mode: "120000",
      size: 11,
      hash: linkHash,
    });
  });

  test("缺失 origin blob 时抛 VirtualOriginUnavailableError", () => {
    const repo = createMemoryRepository();
    const missing = sha1("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const node = {
      id: createNodeId(),
      origin: { kind: "repo-blob" as const, mode: "100644" as const, hash: missing },
      state: { kind: "file" as const, mode: "100644" as const },
    };

    expect(() => statNode(repo.objects, node, "missing.txt")).toThrow(
      VirtualOriginUnavailableError,
    );
  });

  test("statDirectoryNode() 返回目录固定 mode 与 origin tree hash", () => {
    const tree = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    expect(statDirectoryNode(createRootDirectoryNode(tree))).toEqual({
      kind: "tree",
      mode: "040000",
      size: 0,
      hash: tree,
    });
  });
});

describe("cloneNodeGraphForCopy()", () => {
  test("递归复制目录子树后源和目标节点身份隔离", () => {
    const repo = createMemoryRepository();
    const baseTree = repo.createTree([]);
    const store = createVirtualWorktreeMemoryStateStore(baseTree);
    const session = openVirtualWorktree(repo.objects, store);
    session.mkdir("src/lib", { recursive: true });
    session.writeFile("src/lib/a.txt", Buffer.from("content"));

    const root = store.getNode(VIRTUAL_ROOT_NODE_ID);
    if (root === null || root.state.kind !== "directory") {
      throw new Error("Expected root directory node");
    }
    const srcId = root.state.overlay.addedEntries.get("src");
    if (srcId === undefined) {
      throw new Error("Expected src node");
    }
    const srcNode = store.getNode(srcId);
    if (srcNode === null || srcNode.state.kind !== "directory") {
      throw new Error("Expected src directory node");
    }

    const clonedRootId = cloneNodeGraphForCopy(repo.objects, store, srcNode, "src");
    const clonedRoot = store.getNode(clonedRootId);
    if (clonedRoot === null || clonedRoot.state.kind !== "directory") {
      throw new Error("Expected cloned directory node");
    }

    const originalLibId = srcNode.state.overlay.addedEntries.get("lib");
    const clonedLibId = clonedRoot.state.overlay.addedEntries.get("lib");
    if (originalLibId === undefined || clonedLibId === undefined) {
      throw new Error("Expected lib directory nodes");
    }
    expect(clonedLibId).not.toBe(originalLibId);

    const originalLib = store.getNode(originalLibId);
    const clonedLib = store.getNode(clonedLibId);
    if (
      originalLib === null ||
      clonedLib === null ||
      originalLib.state.kind !== "directory" ||
      clonedLib.state.kind !== "directory"
    ) {
      throw new Error("Expected lib directory records");
    }

    const originalFileId = originalLib.state.overlay.addedEntries.get("a.txt");
    const clonedFileId = clonedLib.state.overlay.addedEntries.get("a.txt");
    if (originalFileId === undefined || clonedFileId === undefined) {
      throw new Error("Expected a.txt nodes");
    }
    expect(clonedFileId).not.toBe(originalFileId);

    const originalFile = store.getNode(originalFileId);
    const copiedFile = store.getNode(clonedFileId);
    expect(originalFile?.origin).toEqual(copiedFile?.origin);
    expect(copiedFile?.state.kind).toBe("file");
  });

  test("复制叶子文件时只创建一个新节点", () => {
    const repo = createMemoryRepository();
    const blobHash = repo.writeBlob(Buffer.from("content"));
    const store = createVirtualWorktreeMemoryStateStore(repo.createTree([]));
    const node = {
      id: createNodeId(),
      origin: { kind: "repo-blob" as const, mode: "100644" as const, hash: blobHash },
      state: { kind: "file" as const, mode: "100644" as const },
    };
    store.setNode(node);

    const cloneId = cloneNodeGraphForCopy(repo.objects, store, node, "a.txt");
    const cloned = store.getNode(cloneId);

    expect(cloneId).not.toBe(node.id);
    expect(cloned?.origin).toEqual(node.origin);
    expect(cloned?.state.kind).toBe("file");
  });
});

function rootOverlay(tree: ReturnType<typeof sha1>) {
  const root = createRootDirectoryNode(tree);
  if (root.state.kind !== "directory") {
    throw new Error("Expected root directory node");
  }
  return root.state.overlay;
}
