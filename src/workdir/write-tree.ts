/**
 * Virtual Workdir overlay -> tree 最小化编译
 *
 * 采用 patchTree 式构造：从 change records + overlay 状态收集脏路径，
 * 沿受影响路径定向编译，只重写有变化的目录 tree 对象。
 *
 * 与旧实现的区别：
 * - 不依赖 DirtyDirSummary 预计算，writeFile/delete 等操作不再触发全量遍历
 * - 脏路径收集仅在 writeTree 时按需执行
 * - 已解析节点中的 overlay 修改通过定向遍历发现
 *
 * writeTree() 成功后不清空 overlay，不推进 baseTree。
 */

import { writeObject } from "../objects/raw.ts";
import { createNamedOriginChildLookup, resolveNamedChild } from "./directory-view.ts";
import { originPathNodeId } from "./ids.ts";
import { readRepoTree } from "./origin.ts";
import { VIRTUAL_ROOT_PATH } from "./path.ts";
import { joinChildPath } from "./workdir-path.ts";

import type { SHA1, TreeEntry } from "../core/types.ts";
import type { ObjectDatabase, ObjectSource } from "../core/types/odb.ts";
import type { NormalizedChangeRecord } from "./change-index.ts";
import type { NodeId } from "./ids.ts";
import type { WorkdirNode } from "./nodes.ts";
import type { VirtualWorkdirStateStore } from "./state-store.ts";

// ==================== 编译上下文 ====================

interface CompileContext {
  readonly writeSource: ObjectDatabase;
  readonly readSource: ObjectSource;
  readonly state: VirtualWorkdirStateStore;
  readonly changes: ReadonlyMap<string, NormalizedChangeRecord>;
  readonly dirtyPaths: ReadonlySet<string>;
}

// ==================== 公开 API ====================

/**
 * 将当前 workdir 状态编译为新的根 tree
 *
 * 只重写受 overlay 影响的目录；文件/符号链接仅在 materialized 时写新 blob。
 * 未修改的 repo-backed 条目直接复用 origin hash。
 * 已解析节点是否存在则按“origin 路径节点身份”判断，而不是按对象 hash 判断。
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

  // 收集变更记录（叶子路径的净效应）
  const changes = new Map<string, NormalizedChangeRecord>();
  for (const record of state.listChangeRecords()) {
    changes.set(record.path, record);
  }

  // 构建脏路径集：变更记录路径 + overlay 修改路径 + 各自祖先
  const dirtyPaths = collectDirtyPaths(source, state, changes);

  const ctx: CompileContext = {
    writeSource: source,
    readSource: source,
    state,
    changes,
    dirtyPaths,
  };

  return compileDirectory(ctx, root, VIRTUAL_ROOT_PATH);
}

// ==================== 脏路径收集 ====================

/**
 * 收集所有需要编译的目录路径。
 *
 * 来源：
 * 1. Change records 中每条路径及其祖先
 * 2. 已解析节点中有 overlay 修改的目录及其祖先
 */
function collectDirtyPaths(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  changes: ReadonlyMap<string, NormalizedChangeRecord>,
): Set<string> {
  const dirty = new Set<string>();

  // 来源 1：change records
  for (const path of changes.keys()) {
    addPathAndAncestors(dirty, path);
  }

  // 来源 2：overlay 修改（仅遍历已解析的节点，不触发懒注册）
  const root = state.getNode("root" as NodeId);
  if (root !== null && root.state.kind === "directory") {
    walkResolvedOverlayNodes(source, state, root, VIRTUAL_ROOT_PATH, dirty);
  }

  return dirty;
}

/** 将路径及其所有祖先加入集合 */
function addPathAndAncestors(dirty: Set<string>, path: string): void {
  dirty.add(path);
  while (true) {
    const slashIndex = path.lastIndexOf("/");
    if (slashIndex < 0) {
      if (path !== VIRTUAL_ROOT_PATH) {
        dirty.add(VIRTUAL_ROOT_PATH);
      }
      return;
    }
    path = path.slice(0, slashIndex);
    dirty.add(path);
  }
}

/**
 * 沿已解析节点遍历，将存在 overlay 修改的目录路径加入脏路径集。
 *
 * 仅遍历已在 state 中解析的节点（origin 子节点通过 ensureNodeFromTreeEntry
 * 懒注册时才会在 state 中存在），未解析的子树跳过。
 */
function walkResolvedOverlayNodes(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
  node: WorkdirNode,
  dirPath: string,
  dirty: Set<string>,
): void {
  if (node.state.kind !== "directory") return;

  if (isNodeOverlayDirty(node)) {
    addPathAndAncestors(dirty, dirPath);
  }

  // 检查 origin 中已解析的子目录节点
  if (node.origin.kind === "repo-tree") {
    const tree = readRepoTree(source, node.origin.hash, dirPath);
    for (const entry of tree.entries) {
      if (entry.mode !== "040000") continue;
      const childPath = joinChildPath(dirPath, entry.name);
      const childNode = state.getNode(originPathNodeId(childPath));
      if (childNode === null) continue; // 未解析 → 不可能有 overlay 修改
      walkResolvedOverlayNodes(source, state, childNode, childPath, dirty);
    }
  }

  // 检查 overlay 新增的目录子项
  for (const [name, childId] of node.state.overlay.addedEntries) {
    const childNode = state.getNode(childId);
    if (childNode === null || childNode.state.kind !== "directory") continue;
    const childPath = joinChildPath(dirPath, name);
    walkResolvedOverlayNodes(source, state, childNode, childPath, dirty);
  }
}

function isNodeOverlayDirty(node: WorkdirNode): boolean {
  if (node.state.kind !== "directory") return false;
  return node.state.overlay.addedEntries.size > 0 || node.state.overlay.deletedNames.size > 0;
}

// ==================== 目录编译 ====================

/**
 * 递归编译目录 -> tree 对象
 *
 * 返回新 tree 的 SHA-1（无变化时直接复用 origin hash）。
 */
function compileDirectory(ctx: CompileContext, dirNode: WorkdirNode, dirPath: string): SHA1 {
  if (dirNode.state.kind !== "directory") {
    throw new Error("compileDirectory called on non-directory node");
  }

  // 无任何变更且 origin 存在 → 直接复用
  if (
    !ctx.dirtyPaths.has(dirPath) &&
    !isNodeOverlayDirty(dirNode) &&
    dirNode.origin.kind === "repo-tree"
  ) {
    return dirNode.origin.hash;
  }

  // 读取 origin tree
  let originEntries: readonly TreeEntry[] = [];
  if (dirNode.origin.kind === "repo-tree") {
    const originTree = readRepoTree(ctx.readSource, dirNode.origin.hash, dirPath);
    originEntries = originTree.entries;
  }

  const overlay = dirNode.state.overlay;
  const treeEntries: TreeEntry[] = [];

  // --- 处理 origin 条目（按 origin 顺序） ---
  if (dirNode.origin.kind === "repo-tree") {
    const lookup = createNamedOriginChildLookup(originEntries);

    for (const originEntry of originEntries) {
      // 已被 overlay 删除
      if (overlay.deletedNames.has(originEntry.name)) continue;
      // 已被 overlay 替换（在 addedEntries 循环中处理）
      if (overlay.addedEntries.has(originEntry.name)) continue;

      const childPath = joinChildPath(dirPath, originEntry.name);

      if (originEntry.mode === "040000") {
        // —— 子目录 ——
        const resolved = resolveNamedChild(ctx.state, dirNode, dirPath, lookup, originEntry.name);
        if (resolved.found && resolved.node.state.kind === "directory") {
          if (ctx.dirtyPaths.has(childPath) || isNodeOverlayDirty(resolved.node)) {
            const hash = compileDirectory(ctx, resolved.node, childPath);
            treeEntries.push({ mode: "040000", name: originEntry.name, hash });
          } else {
            // 子目录无任何变化 → 复用 origin entry
            treeEntries.push(originEntry);
          }
        } else if (resolved.found) {
          // Origin 是目录，但被替换为文件/符号链接
          const compiled = compileNodeToEntry(ctx, resolved.node, childPath, originEntry.name);
          if (compiled !== null) treeEntries.push(compiled);
        } else {
          // 节点不存在（不应发生），保守保留 origin entry
          treeEntries.push(originEntry);
        }
      } else {
        // —— 文件/符号链接 ——
        if (ctx.changes.has(childPath)) {
          const resolved = resolveNamedChild(ctx.state, dirNode, dirPath, lookup, originEntry.name);
          if (resolved.found) {
            const compiled = compileNodeToEntry(ctx, resolved.node, childPath, originEntry.name);
            if (compiled !== null) treeEntries.push(compiled);
          }
        } else {
          treeEntries.push(originEntry);
        }
      }
    }
  }

  // --- 处理 overlay 新增条目 ---
  for (const [name, nodeId] of overlay.addedEntries) {
    const childNode = ctx.state.getNode(nodeId);
    if (childNode === null) continue;
    const childPath = joinChildPath(dirPath, name);
    const compiled = compileNodeToEntry(ctx, childNode, childPath, name);
    if (compiled !== null) treeEntries.push(compiled);
  }

  // 排序（Git tree 要求按名称字典序）
  treeEntries.sort((a, b) => a.name.localeCompare(b.name));

  return writeObject(ctx.writeSource, { type: "tree", entries: treeEntries });
}

// ==================== 节点 → TreeEntry 编译 ====================

function compileNodeToEntry(
  ctx: CompileContext,
  node: WorkdirNode,
  childPath: string,
  childName: string,
): TreeEntry | null {
  if (node.state.kind === "directory") {
    const hash = compileDirectory(ctx, node, childPath);
    return { mode: "040000", name: childName, hash };
  }

  if (node.state.kind === "file") {
    if (node.state.content !== undefined) {
      const hash = writeObject(ctx.writeSource, {
        type: "blob",
        content: node.state.content,
      });
      return { mode: node.state.mode, name: childName, hash };
    }
    if (node.origin.kind === "repo-blob") {
      return { mode: node.state.mode, name: childName, hash: node.origin.hash };
    }
    return null;
  }

  if (node.state.kind === "symlink") {
    if (node.state.target !== undefined) {
      const hash = writeObject(ctx.writeSource, {
        type: "blob",
        content: node.state.target,
      });
      return { mode: "120000", name: childName, hash };
    }
    if (node.origin.kind === "repo-blob") {
      return { mode: "120000", name: childName, hash: node.origin.hash };
    }
    return null;
  }

  return null;
}
