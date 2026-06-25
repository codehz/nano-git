/**
 * Virtual Workdir overlay -> tree 最小化编译
 *
 * 遍历 workdir 的目录 overlay，将受影响的目录重写为新 tree，
 * 未修改的 repo-backed 子树/文件尽量复用原对象哈希。
 *
 * writeTree() 成功后不清空 overlay，不推进 baseTree。
 */

import { writeObject } from "../objects/raw.ts";
import {
  createNamedOriginChildLookup,
  observeListedDirectoryChild,
  observeNamedDirectoryChild,
  planAffectedDirectoryChildren,
} from "./directory-view.ts";
import { materializeDirtyDirSummary } from "./dirty-dir.ts";
import { readRepoTree } from "./origin.ts";
import { listDirectoryChildren } from "./workdir-path.ts";

import type { SHA1, TreeEntry } from "../core/types.ts";
import type { ObjectDatabase, ObjectSource } from "../core/types/odb.ts";
import type { NamedOriginChildLookup, ObservedDirectoryChildNode } from "./directory-view.ts";
import type { DirtyDirSummary } from "./dirty-dir.ts";
import type { NodeId } from "./ids.ts";
import type { WorkdirNode } from "./nodes.ts";
import type { VirtualWorkdirStateStore } from "./state-store.ts";

// ==================== 公开 API ====================

/**
 * 将当前 workdir 状态编译为新的根 tree
 *
 * 只重写受 overlay 影响的目录；文件/符号链接仅在 materialized 时写新 blob。
 * 未修改的 repo-backed 条目直接复用 origin hash。
 *
 * @param source - 可写对象数据库（用于写入新 blob/tree）
 * @param state - workdir 内部状态
 * @returns 新根 tree 的 SHA-1
 *
 * @example
 * ```ts
 * const rootHash = writeTreeFromSession(repo.objects, state);
 * ```
 */
export function writeTreeFromSession(
  source: ObjectDatabase,
  state: VirtualWorkdirStateStore,
): SHA1 {
  const root = state.getNode("root" as NodeId);
  if (root === null || root.state.kind !== "directory") {
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
  state: VirtualWorkdirStateStore,
  dirNode: WorkdirNode,
  dirPath = "",
): SHA1 {
  if (dirNode.state.kind !== "directory") {
    throw new Error("compileDirectory called on non-directory node");
  }

  const summary = state.getDirtyDirSummary(dirPath);
  if (
    summary !== null &&
    summary.hashState === "materialized" &&
    summary.currentTreeHash !== null
  ) {
    return summary.currentTreeHash;
  }
  if (summary === null && dirNode.origin.kind === "repo-tree") {
    return dirNode.origin.hash;
  }

  let anyChanged = false;
  const newEntries = collectCompiledEntries(
    writeSource,
    readSource,
    state,
    dirNode,
    dirPath,
    summary,
    (changed) => {
      if (changed) {
        anyChanged = true;
      }
    },
  );

  if (summary !== null && (summary.dirtyEntryCount > 0 || summary.dirtyDescendantCount > 0)) {
    anyChanged = true;
  }

  if (!anyChanged && dirNode.origin.kind === "repo-tree") {
    state.setDirtyDirSummary(materializeDirtyDirSummary(summary, dirPath, dirNode.origin.hash));
    return dirNode.origin.hash;
  }

  newEntries.sort((a, b) => a.name.localeCompare(b.name));
  const treeHash = writeObject(writeSource, { type: "tree", entries: newEntries });
  state.setDirtyDirSummary(materializeDirtyDirSummary(summary, dirPath, treeHash));
  return treeHash;
}

function collectCompiledEntries(
  writeSource: ObjectDatabase,
  readSource: ObjectSource,
  state: VirtualWorkdirStateStore,
  dirNode: WorkdirNode,
  dirPath: string,
  summary: DirtyDirSummary | null,
  markChanged: (changed: boolean) => void,
): TreeEntry[] {
  if (dirNode.state.kind !== "directory") {
    throw new Error("collectCompiledEntries called on non-directory node");
  }

  if (dirNode.origin.kind !== "repo-tree" || summary === null) {
    return listDirectoryChildren(readSource, state, dirNode, dirPath).flatMap((child) => {
      const observedChild = observeListedDirectoryChild(state, dirPath, child);
      if (observedChild === null) {
        return [];
      }
      const entry = compileChildEntry(writeSource, readSource, state, observedChild);
      if (entry === null) {
        return [];
      }
      markChanged(entry.changed);
      return [entry.entry];
    });
  }

  const originTree = readRepoTree(readSource, dirNode.origin.hash, dirPath);
  const originLookup = createNamedOriginChildLookup(originTree.entries);
  const affectedNames = collectAffectedChildNames(summary);
  const childPlan = planAffectedDirectoryChildren(originLookup, affectedNames);
  const out: TreeEntry[] = [];

  for (const planEntry of childPlan) {
    if (!planEntry.shouldCompile) {
      if (planEntry.originEntry === null) {
        throw new Error(`collectCompiledEntries: missing origin entry for '${planEntry.name}'`);
      }
      out.push(planEntry.originEntry);
      continue;
    }

    const compiled = compileNamedChildEntry(
      writeSource,
      readSource,
      state,
      dirNode,
      dirPath,
      planEntry.name,
      originLookup,
    );
    if (compiled === null) {
      continue;
    }
    markChanged(compiled.changed);
    out.push(compiled.entry);
  }

  return out;
}

function collectAffectedChildNames(summary: DirtyDirSummary): ReadonlySet<string> {
  return new Set(summary.affectedNames);
}

function compileNamedChildEntry(
  writeSource: ObjectDatabase,
  readSource: ObjectSource,
  state: VirtualWorkdirStateStore,
  dirNode: WorkdirNode,
  dirPath: string,
  name: string,
  originLookup: NamedOriginChildLookup,
): { readonly entry: TreeEntry; readonly changed: boolean } | null {
  if (dirNode.state.kind !== "directory") {
    throw new Error("compileNamedChildEntry called on non-directory node");
  }

  const observedChild = observeNamedDirectoryChild(state, dirNode, dirPath, originLookup, name);
  if (observedChild === null) {
    return null;
  }
  return compileChildEntry(writeSource, readSource, state, observedChild);
}

function compileChildEntry(
  writeSource: ObjectDatabase,
  readSource: ObjectSource,
  state: VirtualWorkdirStateStore,
  child: Pick<ObservedDirectoryChildNode, "name" | "path" | "node">,
): { readonly entry: TreeEntry; readonly changed: boolean } | null {
  const node = child.node;
  if (node.state.kind === "directory") {
    const newHash = compileDirectory(writeSource, readSource, state, node, child.path);
    const originHash = node.origin.kind === "repo-tree" ? node.origin.hash : null;
    return {
      entry: { mode: "40000", name: child.name, hash: newHash },
      changed: newHash !== originHash,
    };
  }

  if (node.state.kind === "file") {
    if (node.state.content !== undefined) {
      const hash = writeObject(writeSource, {
        type: "blob",
        content: node.state.content,
      });
      return {
        entry: { mode: node.state.mode, name: child.name, hash },
        changed: node.origin.kind !== "repo-blob" || hash !== node.origin.hash,
      };
    }
    if (node.origin.kind === "repo-blob") {
      return {
        entry: { mode: node.state.mode, name: child.name, hash: node.origin.hash },
        changed: false,
      };
    }
    return null;
  }

  if (node.state.target !== undefined) {
    const hash = writeObject(writeSource, {
      type: "blob",
      content: node.state.target,
    });
    return {
      entry: { mode: "120000", name: child.name, hash },
      changed: node.origin.kind !== "repo-blob" || hash !== node.origin.hash,
    };
  }
  if (node.origin.kind === "repo-blob") {
    return {
      entry: { mode: "120000", name: child.name, hash: node.origin.hash },
      changed: false,
    };
  }
  return null;
}
