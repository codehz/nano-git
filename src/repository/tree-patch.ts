/**
 * 增量式 Tree Patch 操作
 *
 * 在不完整重新构造整棵树的前提下，对现有 tree 打补丁，
 * 只更新受影响的路径，支持增、删、改文件（含符号链接）。
 *
 * 核心策略：
 * - 声明式 patch 列表，同路径多次操作最后一个生效
 * - 自动创建缺失的中间目录（类似 mkdir -p）
 * - delete 只能操作文件/符号链接，禁止操作目录
 * - 不存在的路径 delete 会抛出异常
 */

import type { ObjectStore } from "../odb/types.ts";
import type { GitTree, SHA1, TreeEntry } from "../core/types.ts";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Tree patch 操作定义
 *
 * - `upsert`: 路径不存在则创建，存在则覆盖。通过 mode 区分文件类型：
 *   - `"100644"` 普通文件
 *   - `"100755"` 可执行文件
 *   - `"120000"` 符号链接
 * - `delete`: 删除文件或符号链接条目。禁止删除目录（mode 为 "40000" 的条目）。
 */
export type TreePatchOp =
  | { readonly op: "upsert"; readonly path: string; readonly mode: string; readonly hash: SHA1 }
  | { readonly op: "delete"; readonly path: string };

/**
 * Tree patch 结果
 */
export interface TreePatchResult {
  /** 新的根 tree 哈希 */
  readonly rootHash: SHA1;
  /** 本次操作新写入的所有 tree 对象哈希（包含中间节点） */
  readonly writtenTrees: readonly SHA1[];
}

// ============================================================================
// Public API
// ============================================================================

/**
 * 对已有 tree 执行增量 patch 操作
 *
 * 算法描述：
 * 1. 收集所有 upsert 操作涉及的路径（用于 delete 校验）
 * 2. 对操作列表按路径去重（同路径最后一个生效）
 * 3. 从根树开始，将操作按首段路径分组
 * 4. 深层路径递归处理子树，直接路径更新当前层条目
 * 5. 所有新/更新的条目按名称排序后写出新 tree
 *
 * @param objects - 对象存储
 * @param rootHash - 根 tree 哈希
 * @param ops - patch 操作列表（同路径多次操作最后一个生效）
 * @returns patch 结果
 *
 * @example
 * ```ts
 * const result = patchTree(objects, rootHash, [
 *   { op: "upsert", path: "src/main.ts", mode: "100644", hash: blobHash },
 *   { op: "delete", path: "old.ts" },
 *   { op: "upsert", path: "link", mode: "120000", hash: targetBlobHash },
 * ]);
 * ```
 */
export function patchTree(
  objects: ObjectStore,
  rootHash: SHA1,
  ops: TreePatchOp[],
): TreePatchResult {
  if (ops.length === 0) {
    return { rootHash, writtenTrees: [] };
  }

  // 验证路径格式
  for (const op of ops) {
    validatePath(op.path);
  }

  // 收集所有 upsert 路径（用于 delete 校验：同一批次中 upsert 再 delete 是允许的）
  const upsertedPaths = new Set<string>();
  for (const op of ops) {
    if (op.op === "upsert") {
      upsertedPaths.add(op.path);
    }
  }

  // 同路径去重：最后一个生效
  const dedupedOps = dedupOpsByPath(ops);

  const result = applyPatchRecursive(objects, rootHash, dedupedOps, "", upsertedPaths);

  return {
    rootHash: result.hash,
    writtenTrees: result.written,
  };
}

// ============================================================================
// 路径工具
// ============================================================================

/**
 * 验证 Git tree 路径格式
 */
function validatePath(path: string): void {
  if (path === "") {
    throw new Error("Path must not be empty");
  }
  if (path.startsWith("/")) {
    throw new Error(`Path must not start with '/': ${path}`);
  }
  if (path.endsWith("/")) {
    throw new Error(`Path must not end with '/': ${path}`);
  }
  if (path.includes("//")) {
    throw new Error(`Path must not contain consecutive slashes: ${path}`);
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`Path must not contain '.' or '..': ${path}`);
    }
  }
}

/**
 * 按路径去重，同路径最后一个操作生效
 */
function dedupOpsByPath(ops: TreePatchOp[]): TreePatchOp[] {
  const map = new Map<string, TreePatchOp>();
  for (const op of ops) {
    map.set(op.path, op);
  }
  return Array.from(map.values());
}

// ============================================================================
// 核心递归算法
// ============================================================================

/**
 * 递归应用 patch 操作到指定子树
 *
 * @param objects - 对象存储
 * @param treeHash - 当前子树哈希（null 表示新建空树）
 * @param ops - 去重后的操作列表（作用域为当前子树）
 * @param prefix - 当前路径前缀（用于错误消息和 upsertedPaths 匹配）
 * @param upsertedPaths - 原始操作列表中所有 upsert 的全路径集合
 */
function applyPatchRecursive(
  objects: ObjectStore,
  treeHash: SHA1 | null,
  ops: TreePatchOp[],
  prefix: string,
  upsertedPaths: Set<string>,
): { hash: SHA1; written: SHA1[] } {
  // 读取现有 tree 条目
  const existingEntries: TreeEntry[] = readTreeEntries(objects, treeHash);

  // 按首段路径将操作分为两组：
  // - directOps: 直接作用于当前层的操作（路径只有一段）
  // - deeperOps: 需要递归到子树的操作（路径有多段），按首段分组
  const { directOps, deeperOps } = groupOpsByDepth(ops);

  // 最终条目映射表：name -> TreeEntry
  const finalEntryMap = new Map<string, TreeEntry>();
  const writtenTrees: SHA1[] = [];

  // ---- Step 1: 处理深层操作（递归到子树） ----
  for (const [name, childOps] of deeperOps) {
    const existingEntry = existingEntries.find((e) => e.name === name);
    const existingHash = existingEntry?.hash ?? null;

    // 验证：如果现有条目存在且不是目录，不能在其下递归操作
    if (existingEntry !== undefined && existingEntry.mode !== "40000") {
      throw new Error(
        `Cannot access '${prefix}${name}': existing entry is not a directory (mode: ${existingEntry.mode})`,
      );
    }

    // 验证：如果子树不存在且所有子操作都是 delete 且不在 upsertedPaths 中
    if (existingHash === null) {
      const hasUpsertInBatch =
        childOps.some((op) => op.op === "upsert") ||
        childOps.some(
          (op) => op.op === "delete" && upsertedPaths.has(`${prefix}${name}/${op.path}`),
        );
      if (childOps.every((op) => op.op === "delete") && !hasUpsertInBatch) {
        const samplePath = `${prefix}${name}/${childOps[0]!.path}`;
        throw new Error(`Cannot delete '${samplePath}': path does not exist`);
      }
    }

    // 递归处理子树
    const result = applyPatchRecursive(
      objects,
      existingHash,
      childOps,
      `${prefix}${name}/`,
      upsertedPaths,
    );
    writtenTrees.push(...result.written);
    finalEntryMap.set(name, { mode: "40000", name, hash: result.hash });
  }

  // 单独跟踪已删除的条目名（避免与 finalEntryMap 的"未修改"语义混淆）
  const deletedNames = new Set<string>();

  // ---- Step 2: 处理直接操作（覆盖深层操作产生的同名条目） ----
  for (const op of directOps) {
    if (op.op === "upsert") {
      finalEntryMap.set(op.path, {
        mode: op.mode,
        name: op.path,
        hash: op.hash,
      });
    } else {
      // delete 操作
      const fullPath = prefix + op.path;
      const existsInExisting = existingEntries.some((e) => e.name === op.path);
      const existsInCreated = finalEntryMap.has(op.path);
      const existsInBatch = upsertedPaths.has(fullPath);

      if (!existsInExisting && !existsInCreated && !existsInBatch) {
        throw new Error(`Cannot delete '${prefix}${op.path}': path does not exist`);
      }

      // 验证：不能删除目录
      const existingEntry = existingEntries.find((e) => e.name === op.path);
      if (existingEntry?.mode === "40000") {
        throw new Error(
          `Cannot delete '${prefix}${op.path}': entry is a directory, only files and symlinks can be deleted`,
        );
      }

      deletedNames.add(op.path);
      // 如果该路径之前被同批 upsert 创建，也要从 finalEntryMap 中移除
      finalEntryMap.delete(op.path);
    }
  }

  // ---- Step 3: 合并条目 ----
  const finalEntries: TreeEntry[] = [];

  // 保留未被影响到的现有条目（排除已删除的）
  for (const entry of existingEntries) {
    if (!finalEntryMap.has(entry.name) && !deletedNames.has(entry.name)) {
      finalEntries.push(entry);
    }
  }

  // 添加新/更新的条目
  for (const [, entry] of finalEntryMap) {
    finalEntries.push(entry);
  }

  // 按名称排序（Git tree 约定）
  finalEntries.sort((a, b) => a.name.localeCompare(b.name));

  // ---- Step 4: 写入新 tree ----
  const newTree: GitTree = { type: "tree", entries: finalEntries };
  const newHash = objects.write(newTree);
  writtenTrees.push(newHash);

  return { hash: newHash, written: writtenTrees };
}

// ============================================================================
// 内部辅助
// ============================================================================

/**
 * 读取 tree 对象的条目列表
 */
function readTreeEntries(objects: ObjectStore, treeHash: SHA1 | null): TreeEntry[] {
  if (treeHash === null) {
    return [];
  }
  const obj = objects.read(treeHash);
  if (obj.type !== "tree") {
    throw new Error(`Expected tree object, got '${obj.type}' for hash '${treeHash}'`);
  }
  return obj.entries;
}

/**
 * 将操作列表按路径深度分组
 *
 * 返回：
 * - directOps: 路径只有一段的操作（直接作用于当前层）
 * - deeperOps: 路径有多段的操作，按首段分组
 */
function groupOpsByDepth(ops: TreePatchOp[]): {
  directOps: TreePatchOp[];
  deeperOps: Map<string, TreePatchOp[]>;
} {
  const directOps: TreePatchOp[] = [];
  const deeperOps = new Map<string, TreePatchOp[]>();

  for (const op of ops) {
    const segments = op.path.split("/");
    const first = segments[0]!;

    if (segments.length === 1) {
      directOps.push(op);
    } else {
      const rest = segments.slice(1).join("/");
      const childOp: TreePatchOp =
        op.op === "upsert"
          ? { op: "upsert", path: rest, mode: op.mode, hash: op.hash }
          : { op: "delete", path: rest };

      const existing = deeperOps.get(first) ?? [];
      existing.push(childOp);
      deeperOps.set(first, existing);
    }
  }

  return { directOps, deeperOps };
}
