/**
 * Virtual Workdir overlay -> tree 最小化编译
 *
 * 遍历 session 的目录 overlay，将受影响的目录重写为新 tree，
 * 未修改的 repo-backed 子树/文件尽量复用原对象哈希。
 *
 * writeTree() 成功后不清空 overlay，不推进 baseTree。
 */

import { writeObject } from "../objects/raw.ts";
import { isDirectoryOverlayDirty } from "./nodes.ts";
import { listDirectoryChildren } from "./session-internal.ts";

import type { SHA1, TreeEntry } from "../core/types.ts";
import type { ObjectDatabase, ObjectSource } from "../core/types/odb.ts";
import type { VirtualWorkdirMemoryState } from "./memory-backend.ts";
import type { SessionNode } from "./nodes.ts";

// ==================== 公开 API ====================

/**
 * 将当前 session 状态编译为新的根 tree
 *
 * 只重写受 overlay 影响的目录；文件/符号链接仅在 materialized 时写新 blob。
 * 未修改的 repo-backed 条目直接复用 origin hash。
 *
 * @param source - 可写对象数据库（用于写入新 blob/tree）
 * @param state - session 内存状态
 * @returns 新根 tree 的 SHA-1
 *
 * @example
 * ```ts
 * const rootHash = writeTreeFromSession(repo.objects, state);
 * ```
 */
export function writeTreeFromSession(
  source: ObjectDatabase,
  state: VirtualWorkdirMemoryState,
): SHA1 {
  const root = state.nodes.get("root" as import("./ids.ts").NodeId);
  if (!root || root.state.kind !== "directory") {
    throw new Error("Virtual workdir: root node is missing or not a directory");
  }
  return compileDirectory(source, source, state, root);
}

// ==================== 内部编译 ====================

/**
 * 递归编译目录 overlay -> 新 tree
 *
 * 返回新 tree 的 SHA-1（若目录无任何变化则直接复用 origin hash）。
 */
function compileDirectory(
  writeSource: ObjectDatabase,
  readSource: ObjectSource,
  state: VirtualWorkdirMemoryState,
  dirNode: SessionNode,
): SHA1 {
  if (dirNode.state.kind !== "directory") {
    throw new Error("compileDirectory called on non-directory node");
  }

  const children = listDirectoryChildren(readSource, state, dirNode, "");
  let anyChanged = false;
  const newEntries: TreeEntry[] = [];

  for (const child of children) {
    const node = state.nodes.get(child.nodeId);
    if (!node) {
      continue;
    }

    if (node.state.kind === "directory") {
      const newHash = compileDirectory(writeSource, readSource, state, node);
      const originHash = node.origin.kind === "repo-tree" ? node.origin.hash : null;
      if (newHash !== originHash) {
        anyChanged = true;
      }
      newEntries.push({ mode: "40000", name: child.name, hash: newHash });
    } else if (node.state.kind === "file") {
      if (node.state.content !== undefined) {
        const hash = writeObject(writeSource, {
          type: "blob",
          content: node.state.content,
        });
        anyChanged = true;
        newEntries.push({ mode: node.state.mode, name: child.name, hash });
      } else if (node.origin.kind === "repo-blob") {
        newEntries.push({
          mode: node.state.mode,
          name: child.name,
          hash: node.origin.hash,
        });
      }
    } else {
      // symlink
      if (node.state.target !== undefined) {
        const hash = writeObject(writeSource, {
          type: "blob",
          content: node.state.target,
        });
        anyChanged = true;
        newEntries.push({ mode: "120000", name: child.name, hash });
      } else if (node.origin.kind === "repo-blob") {
        newEntries.push({
          mode: "120000",
          name: child.name,
          hash: node.origin.hash,
        });
      }
    }
  }

  if (isDirectoryOverlayDirty(dirNode.state.overlay)) {
    anyChanged = true;
  }

  if (!anyChanged && dirNode.origin.kind === "repo-tree") {
    return dirNode.origin.hash;
  }

  newEntries.sort((a, b) => a.name.localeCompare(b.name));
  return writeObject(writeSource, { type: "tree", entries: newEntries });
}
