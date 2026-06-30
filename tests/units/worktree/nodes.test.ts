/**
 * worktree/nodes.ts 单元测试
 */
import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import {
  createNodeId,
  originPathNodeId,
  resetNodeIdCounterForTests,
  VIRTUAL_ROOT_NODE_ID,
} from "@/worktree/ids.ts";
import {
  cloneWorktreeNodeForCopy,
  createNewDirectoryNode,
  createRootDirectoryNode,
  isNodeDirty,
} from "@/worktree/nodes.ts";
import { overlayBindEntry } from "@/worktree/overlay.ts";

describe("createRootDirectoryNode()", () => {
  test("根节点使用稳定 ID", () => {
    const tree = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const node = createRootDirectoryNode(tree);
    expect(node.id).toBe(VIRTUAL_ROOT_NODE_ID);
    expect(node.origin).toEqual({ kind: "repo-tree", hash: tree });
  });

  test("originPathNodeId 按路径分配稳定且隔离的节点身份", () => {
    expect(originPathNodeId("a.txt")).toBe(originPathNodeId("a.txt"));
    expect(originPathNodeId("a.txt")).not.toBe(originPathNodeId("b.txt"));
  });
});

describe("copy 节点语义", () => {
  test("cloneWorktreeNodeForCopy 目录浅复制且共享 origin", () => {
    resetNodeIdCounterForTests();
    const tree = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const src = createRootDirectoryNode(tree);
    const copyId = createNodeId();
    const copy = cloneWorktreeNodeForCopy(src, copyId);
    expect(copy.id).toBe(copyId);
    expect(copy.origin).toEqual(src.origin);
    expect(copy.state.kind).toBe("directory");
    if (copy.state.kind === "directory") {
      expect(copy.state.overlay.addedEntries.size).toBe(0);
    }
  });

  test("新建目录带脏 overlay 时可被识别为 dirty", () => {
    resetNodeIdCounterForTests();
    const fresh = createNewDirectoryNode(createNodeId());
    if (fresh.state.kind !== "directory") {
      throw new Error("expected directory node");
    }
    const dirtyOverlay = overlayBindEntry(fresh.state.overlay, "a", createNodeId());
    const dirty = { ...fresh, state: { kind: "directory" as const, overlay: dirtyOverlay } };
    expect(isNodeDirty(dirty)).toBe(true);
  });
});
