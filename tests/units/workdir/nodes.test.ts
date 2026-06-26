/**
 * workdir/nodes.ts 单元测试
 */
import { describe, test, expect } from "bun:test";

import { sha1 } from "@/core/types.ts";
import {
  createNodeId,
  originPathNodeId,
  resetNodeIdCounterForTests,
  VIRTUAL_ROOT_NODE_ID,
} from "@/workdir/ids.ts";
import {
  cloneWorkdirNodeForCopy,
  createNewDirectoryNode,
  createRootDirectoryNode,
  isNodeDirty,
  nodeHasRepoOrigin,
  revertNodeState,
} from "@/workdir/nodes.ts";
import { overlayBindEntry } from "@/workdir/overlay.ts";

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

describe("revert / copy 节点语义", () => {
  test("revert 清空目录 overlay", () => {
    resetNodeIdCounterForTests();
    const tree = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const root = createRootDirectoryNode(tree);
    if (root.state.kind !== "directory") {
      throw new Error("expected directory root");
    }
    const dirtyOverlay = overlayBindEntry(root.state.overlay, "a", createNodeId());
    const dirty = { ...root, state: { kind: "directory" as const, overlay: dirtyOverlay } };
    expect(isNodeDirty(dirty)).toBe(true);
    const reverted = revertNodeState(dirty);
    expect(isNodeDirty(reverted)).toBe(false);
    expect(nodeHasRepoOrigin(reverted)).toBe(true);
  });

  test("cloneWorkdirNodeForCopy 目录浅复制且共享 origin", () => {
    resetNodeIdCounterForTests();
    const tree = sha1("95d09f2b10159347eece71399a7e2e907ea3df4f");
    const src = createRootDirectoryNode(tree);
    const copyId = createNodeId();
    const copy = cloneWorkdirNodeForCopy(src, copyId);
    expect(copy.id).toBe(copyId);
    expect(copy.origin).toEqual(src.origin);
    expect(copy.state.kind).toBe("directory");
    if (copy.state.kind === "directory") {
      expect(copy.state.overlay.addedEntries.size).toBe(0);
    }
  });

  test("无 origin 的新建目录不可 revert 为 repo 状态", () => {
    resetNodeIdCounterForTests();
    const fresh = createNewDirectoryNode(createNodeId());
    expect(nodeHasRepoOrigin(fresh)).toBe(false);
    expect(revertNodeState(fresh)).toBe(fresh);
  });
});
