/**
 * 增量式 Tree Patch 操作
 *
 * 在不完整重新构造整棵树的前提下，对现有 tree 打补丁，
 * 只更新受影响的路径，支持增、删、改、重命名操作。
 *
 * 核心策略：
 * - 声明式 patch 列表，同路径多次操作最后一个生效
 * - 自动创建缺失的中间目录（类似 mkdir -p）
 * - delete 支持文件/符号链接/目录条目
 * - rename 支持文件/符号链接/目录（直接移动 tree 引用，无需递归重写子树）
 * - rename 按顺序逐一处理，upsert/delete 段内保持 batch 算法
 * - 不存在的路径 delete/rename 会抛出异常
 */

import { writeObject, readObject } from "../../objects/raw.ts";

import type { GitTree, SHA1, TreeEntry } from "../../core/types.ts";
import type { ObjectDatabase } from "../../odb/types.ts";

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
 * - `delete`: 删除文件、符号链接或目录条目。目录条目删除仅移除 parent tree 引用。
 * - `rename`: 移动文件、符号链接或目录到新路径。源路径不存在则抛出异常。
 *   目录 rename 只移动 tree entry 引用，子树内容（tree hash）不变。
 */
export type TreePatchOp =
  | { readonly op: "upsert"; readonly path: string; readonly mode: string; readonly hash: SHA1 }
  | { readonly op: "delete"; readonly path: string }
  | { readonly op: "rename"; readonly from: string; readonly to: string };

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
 * 1. 验证所有操作的路径格式
 * 2. 将 ops 按 rename 操作分割为若干连续段
 * 3. 段内 upsert/delete 保持现有 batch 算法（去重 + 递归）
 * 4. rename 依次单独执行：查找源路径条目 → upsert(to) + delete(from) → batch 算法
 * 5. 所有新/更新的条目按名称排序后写出新 tree
 *
 * @param objects - 对象存储
 * @param rootHash - 根 tree 哈希
 * @param ops - patch 操作列表（同路径多次操作最后一个生效，rename 按顺序逐一执行）
 * @returns patch 结果
 *
 * @example
 * ```ts
 * const result = patchTree(objects, rootHash, [
 *   { op: "upsert", path: "src/main.ts", mode: "100644", hash: blobHash },
 *   { op: "delete", path: "old.ts" },
 *   { op: "rename", from: "src/utils", to: "lib/utils" },
 * ]);
 * ```
 */
export function patchTree(
  objects: ObjectDatabase,
  rootHash: SHA1,
  ops: TreePatchOp[],
): TreePatchResult {
  if (ops.length === 0) {
    return { rootHash, writtenTrees: [] };
  }

  // 验证路径格式
  for (const op of ops) {
    if (op.op === "rename") {
      validatePath(op.from);
      validatePath(op.to);
    } else {
      validatePath(op.path);
    }
  }

  // 按 rename 分割 ops 并顺序执行
  const result = processOpsSequentially(objects, rootHash, ops);

  return {
    rootHash: result.hash,
    writtenTrees: result.written,
  };
}

// ============================================================================
// 顺序执行引擎
// ============================================================================

/**
 * 顺序执行 ops，rename 打断 batch
 *
 * 将连续的非 rename op 聚合成 batch，用现有递归算法处理；
 * rename op 单独执行，每次在当前 tree 状态上查找源路径并转换为 upsert+delete。
 */
function processOpsSequentially(
  objects: ObjectDatabase,
  rootHash: SHA1,
  ops: TreePatchOp[],
): { hash: SHA1; written: SHA1[] } {
  let currentHash = rootHash;
  const allWritten: SHA1[] = [];
  let currentBatch: TreePatchOp[] = [];

  function flushBatch(): void {
    if (currentBatch.length === 0) return;
    const result = applyPatchBatch(objects, currentHash, currentBatch);
    currentHash = result.hash;
    allWritten.push(...result.written);
    currentBatch = [];
  }

  for (const op of ops) {
    if (op.op === "rename") {
      flushBatch();

      if (op.from === op.to) continue; // no-op

      // 在当前 tree 中查找源条目
      const entry = findEntryByPath(objects, currentHash, op.from);
      if (entry === null) {
        throw new Error(`Cannot rename '${op.from}': path does not exist`);
      }

      // 转换为 upsert + delete 并执行
      const renameOps: TreePatchOp[] = [
        { op: "upsert", path: op.to, mode: entry.mode, hash: entry.hash },
        { op: "delete", path: op.from },
      ];
      const result = applyPatchBatch(objects, currentHash, renameOps);
      currentHash = result.hash;
      allWritten.push(...result.written);
    } else {
      currentBatch.push(op);
    }
  }

  flushBatch();
  return { hash: currentHash, written: allWritten };
}

/**
 * 在 tree 中查找路径对应的条目
 *
 * 沿路径依次读取 tree 对象，最后一段返回目标条目。
 * 中间段必须为目录（mode "040000"），否则抛出异常。
 */
function findEntryByPath(objects: ObjectDatabase, treeHash: SHA1, path: string): TreeEntry | null {
  const segments = path.split("/");
  let currentHash = treeHash;

  for (let i = 0; i < segments.length; i++) {
    const obj = readObject(objects, currentHash);
    if (obj.type !== "tree") {
      throw new Error(
        `Expected tree at '${segments.slice(0, i).join("/") || "/"}', got '${obj.type}'`,
      );
    }
    const entry = obj.entries.find((e) => e.name === segments[i]!);
    if (!entry) return null;

    if (i === segments.length - 1) {
      return entry;
    }

    if (entry.mode !== "040000") {
      throw new Error(
        `Cannot access '${segments.slice(0, i + 1).join("/")}': not a directory (mode: ${entry.mode})`,
      );
    }
    currentHash = entry.hash;
  }

  return null;
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
 *
 * 仅处理 upsert/delete（rename 由顺序执行引擎单独处理，不会传给此函数）。
 */
function dedupOpsByPath(ops: TreePatchOp[]): TreePatchOp[] {
  const map = new Map<string, TreePatchOp>();
  for (const op of ops) {
    if (op.op === "rename") continue; // 防御性跳过，实际不会发生
    map.set(op.path, op);
  }
  return Array.from(map.values());
}

// ============================================================================
// Batch 处理入口
// ============================================================================

/**
 * 对一批 upsert/delete 操作执行增量 patch
 *
 * 这是原先的 patchTree 实现，提取为内部函数供顺序执行引擎调用。
 * 该函数不处理 rename 操作——调用方保证传入的 ops 不含 rename。
 */
function applyPatchBatch(
  objects: ObjectDatabase,
  rootHash: SHA1,
  ops: TreePatchOp[],
): { hash: SHA1; written: SHA1[] } {
  if (ops.length === 0) {
    return { hash: rootHash, written: [] };
  }

  // 收集所有 upsert 路径（用于 delete 校验：同一批次中 upsert 再 delete 是允许的）
  const upsertedPaths = new Set<string>();
  for (const op of ops) {
    if (op.op === "upsert") {
      upsertedPaths.add(op.path);
    }
  }

  // 同路径去重：最后一个生效（rename 不会到这里）
  const dedupedOps = dedupOpsByPath(ops);

  const result = applyPatchRecursive(objects, rootHash, dedupedOps, "", upsertedPaths);

  return { hash: result.hash, written: result.written };
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
  objects: ObjectDatabase,
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
    if (existingEntry !== undefined && existingEntry.mode !== "040000") {
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
    finalEntryMap.set(name, { mode: "040000", name, hash: result.hash });
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
    } else if (op.op === "delete") {
      // delete 操作（rename 由顺序执行引擎处理，不会到达这里）
      const fullPath = prefix + op.path;
      const existsInExisting = existingEntries.some((e) => e.name === op.path);
      const existsInCreated = finalEntryMap.has(op.path);
      const existsInBatch = upsertedPaths.has(fullPath);

      if (!existsInExisting && !existsInCreated && !existsInBatch) {
        throw new Error(`Cannot delete '${prefix}${op.path}': path does not exist`);
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
  const newHash = writeObject(objects, newTree);
  writtenTrees.push(newHash);

  return { hash: newHash, written: writtenTrees };
}

// ============================================================================
// 内部辅助
// ============================================================================

/**
 * 读取 tree 对象的条目列表
 */
function readTreeEntries(objects: ObjectDatabase, treeHash: SHA1 | null): TreeEntry[] {
  if (treeHash === null) {
    return [];
  }
  const obj = readObject(objects, treeHash);
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
    if (op.op === "rename") continue; // 防御性跳过，rename 不会到达 batch 递归
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
