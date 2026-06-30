/**
 * worktree/overlay.ts 单元测试（不依赖 Git ODB）
 */
import { describe, test, expect } from "bun:test";

import { createNodeId, resetNodeIdCounterForTests } from "@/worktree/model/ids.ts";
import {
  createEmptyDirectoryOverlay,
  mergeDirectoryChildren,
  overlayBindEntry,
  overlayTombstoneEntry,
  resolveChildNodeId,
  type OriginDirectoryChild,
} from "@/worktree/model/overlay.ts";

function child(name: string, mode: string, nodeId = createNodeId()): OriginDirectoryChild {
  return { name, mode, nodeId };
}

describe("mergeDirectoryChildren()", () => {
  test("纯 origin 按名称排序", () => {
    resetNodeIdCounterForTests();
    const a = child("b.txt", "100644");
    const b = child("a.txt", "100644");
    const merged = mergeDirectoryChildren([a, b], createEmptyDirectoryOverlay(), new Map());
    expect(merged.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
  });

  test("deletedNames 打 tombstone", () => {
    resetNodeIdCounterForTests();
    const origin = [child("keep.txt", "100644"), child("gone.txt", "100644")];
    let overlay = createEmptyDirectoryOverlay();
    overlay = overlayTombstoneEntry(overlay, "gone.txt");
    const merged = mergeDirectoryChildren(origin, overlay, new Map());
    expect(merged.map((e) => e.name)).toEqual(["keep.txt"]);
  });

  test("addedEntries 覆盖同名 origin", () => {
    resetNodeIdCounterForTests();
    const originId = createNodeId();
    const newId = createNodeId();
    const origin = [child("f.txt", "100644", originId)];
    let overlay = overlayBindEntry(createEmptyDirectoryOverlay(), "f.txt", newId);
    const modes = new Map([["f.txt", "100755"]]);
    const merged = mergeDirectoryChildren(origin, overlay, modes);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.nodeId).toBe(newId);
    expect(merged[0]!.mode).toBe("100755");
  });

  test("纯新增条目需要 mode 映射", () => {
    resetNodeIdCounterForTests();
    const newId = createNodeId();
    const overlay = overlayBindEntry(createEmptyDirectoryOverlay(), "new.txt", newId);
    const merged = mergeDirectoryChildren([], overlay, new Map([["new.txt", "100644"]]));
    expect(merged[0]!.name).toBe("new.txt");
  });
});

describe("overlay 结构操作语义", () => {
  test("copy + delete 可以表达重命名后的可见结果", () => {
    resetNodeIdCounterForTests();
    const originalId = createNodeId();
    const copiedId = createNodeId();
    const origin = [child("old", "040000", originalId)];
    let overlay = createEmptyDirectoryOverlay();
    overlay = overlayTombstoneEntry(overlay, "old");
    overlay = overlayBindEntry(overlay, "new", copiedId);
    const merged = mergeDirectoryChildren(origin, overlay, new Map([["new", "040000"]]));
    expect(merged.map((e) => e.name)).toEqual(["new"]);
    expect(merged[0]!.nodeId).toBe(copiedId);
  });

  test("copy 使用不同 nodeId（由调用方绑定）", () => {
    resetNodeIdCounterForTests();
    const srcId = createNodeId();
    const copyId = createNodeId();
    const origin = [child("src.txt", "100644", srcId)];
    let overlay = overlayBindEntry(createEmptyDirectoryOverlay(), "dst.txt", copyId);
    const merged = mergeDirectoryChildren(origin, overlay, new Map([["dst.txt", "100644"]]));
    const names = merged.map((e) => e.name).sort();
    expect(names).toEqual(["dst.txt", "src.txt"]);
    expect(merged.find((e) => e.name === "dst.txt")!.nodeId).toBe(copyId);
    expect(merged.find((e) => e.name === "src.txt")!.nodeId).toBe(srcId);
  });

  test("delete 仅 tombstone 不抹除其他子项", () => {
    resetNodeIdCounterForTests();
    const origin = [child("a", "100644"), child("b", "100644")];
    const overlay = overlayTombstoneEntry(createEmptyDirectoryOverlay(), "a");
    const merged = mergeDirectoryChildren(origin, overlay, new Map());
    expect(merged.map((e) => e.name)).toEqual(["b"]);
  });

  test("resolveChildNodeId 在合成视图中解析", () => {
    resetNodeIdCounterForTests();
    const id = createNodeId();
    const origin = [child("x", "100644", id)];
    const overlay = createEmptyDirectoryOverlay();
    expect(resolveChildNodeId(origin, overlay, new Map(), "x")).toBe(id);
    expect(resolveChildNodeId(origin, overlay, new Map(), "missing")).toBeNull();
  });
});
