/**
 * Virtual Workdir session 内部共享逻辑
 *
 * 供 session.ts 与 write-tree.ts 复用：
 * - 路径解析（resolvePath）
 * - 目录子项展开（listDirectoryChildren）
 * - origin 节点懒注册（ensureNodeFromTreeEntry）
 */

import { VirtualNotDirectoryError } from "../core/errors.ts";
import { originBackedNodeId, VIRTUAL_ROOT_NODE_ID } from "./ids.ts";
import { readRepoTree, treeEntryToNodeOrigin } from "./origin.ts";
import { mergeDirectoryChildren } from "./overlay.ts";
import { assertValidVirtualPath, joinPath, splitPathSegments, VIRTUAL_ROOT_PATH } from "./path.ts";

import type { TreeEntry } from "../core/types.ts";
import type { ObjectSource } from "../core/types/odb.ts";
import type { NodeId } from "./ids.ts";
import type { VirtualWorkdirMemoryState } from "./memory-backend.ts";
import type { SessionNode } from "./nodes.ts";
import type { MergedDirectoryChild, OriginDirectoryChild } from "./overlay.ts";

// ==================== 路径解析 ====================

export type ResolveResult =
  | { readonly found: false; readonly node: null }
  | { readonly found: true; readonly node: SessionNode };

function getRootNode(state: VirtualWorkdirMemoryState): SessionNode {
  const root = state.nodes.get(VIRTUAL_ROOT_NODE_ID);
  if (root === undefined) {
    throw new Error("Virtual workdir session is missing root node");
  }
  return root;
}

/**
 * 从根目录沿路径分段解析到目标节点
 */
export function resolvePath(
  source: ObjectSource,
  state: VirtualWorkdirMemoryState,
  path: string,
): ResolveResult {
  assertValidVirtualPath(path);
  const segments = splitPathSegments(path);
  let current = getRootNode(state);
  let currentPath = VIRTUAL_ROOT_PATH;

  for (const segment of segments) {
    if (current.state.kind !== "directory") {
      return { found: false, node: null };
    }
    const children = listDirectoryChildren(source, state, current, currentPath);
    const child = children.find((c) => c.name === segment);
    if (child === undefined) {
      return { found: false, node: null };
    }
    currentPath = joinPath(currentPath === VIRTUAL_ROOT_PATH ? null : currentPath, segment);
    const childNode = state.nodes.get(child.nodeId);
    if (childNode === undefined) {
      return { found: false, node: null };
    }
    current = childNode;
  }

  return { found: true, node: current };
}

/**
 * 根据父节点与子条目名解析子节点
 */
export function resolveChild(
  source: ObjectSource,
  state: VirtualWorkdirMemoryState,
  parentNode: SessionNode,
  parentPath: string,
  name: string,
): { found: false; node: null } | { found: true; node: SessionNode } {
  if (parentNode.state.kind !== "directory") {
    return { found: false, node: null };
  }
  const children = listDirectoryChildren(source, state, parentNode, parentPath);
  const child = children.find((c) => c.name === name);
  if (child === undefined) {
    return { found: false, node: null };
  }
  const childNode = state.nodes.get(child.nodeId);
  if (childNode === undefined) {
    return { found: false, node: null };
  }
  return { found: true, node: childNode };
}

// ==================== 目录子项展开 ====================

/**
 * 确保 origin 条目对应的 session 节点已懒注册
 */
export function ensureNodeFromTreeEntry(
  state: VirtualWorkdirMemoryState,
  entry: TreeEntry,
): NodeId {
  const id = originBackedNodeId(entry.hash);
  if (!state.nodes.has(id)) {
    const origin = treeEntryToNodeOrigin(entry);
    let nodeState: SessionNode["state"];
    if (entry.mode === "40000") {
      nodeState = {
        kind: "directory",
        overlay: { addedEntries: new Map(), deletedNames: new Set() },
      };
    } else if (entry.mode === "120000") {
      nodeState = { kind: "symlink", mode: "120000" };
    } else {
      const mode: "100644" | "100755" = entry.mode === "100755" ? "100755" : "100644";
      nodeState = { kind: "file", mode };
    }
    state.nodes.set(id, { id, origin, state: nodeState });
  }
  return id;
}

/**
 * 展开目录的完整子项列表（origin + overlay 合成）
 */
export function listDirectoryChildren(
  source: ObjectSource,
  state: VirtualWorkdirMemoryState,
  dirNode: SessionNode,
  dirPath: string,
): MergedDirectoryChild[] {
  if (dirNode.state.kind !== "directory") {
    throw new VirtualNotDirectoryError(dirPath);
  }

  let originChildren: OriginDirectoryChild[] = [];
  if (dirNode.origin.kind === "repo-tree") {
    const tree = readRepoTree(source, dirNode.origin.hash, dirPath);
    originChildren = tree.entries.map((entry) => {
      const childNodeId = ensureNodeFromTreeEntry(state, entry);
      return { name: entry.name, mode: entry.mode, nodeId: childNodeId };
    });
  }

  const addedModes = buildAddedModes(state, dirNode);

  return mergeDirectoryChildren(originChildren, dirNode.state.overlay, addedModes);
}

/**
 * 构建 overlay addedEntries 对应的 mode map
 */
export function buildAddedModes(
  state: VirtualWorkdirMemoryState,
  dirNode: SessionNode,
): ReadonlyMap<string, string> {
  if (dirNode.state.kind !== "directory") {
    return new Map();
  }
  const addedModes = new Map<string, string>();
  for (const name of dirNode.state.overlay.addedEntries.keys()) {
    const nodeId = dirNode.state.overlay.addedEntries.get(name)!;
    const node = state.nodes.get(nodeId);
    if (node !== undefined) {
      addedModes.set(name, sessionNodeMode(node));
    }
  }
  return addedModes;
}

// ==================== 辅助 ====================

function sessionNodeMode(node: SessionNode): string {
  if (node.state.kind === "directory") {
    return "40000";
  }
  if (node.state.kind === "symlink") {
    return "120000";
  }
  return node.state.mode;
}
