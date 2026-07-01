/**
 * 从对象源读取 repo-backed origin（tree/blob）
 *
 * 仅依赖 ObjectSource，不绑定具体 ODB 后端实现。
 */

import { VirtualOriginUnavailableError } from "../../errors.ts";
import { tryReadObject } from "../../objects/raw.ts";

import type { GitTree, SHA1, TreeEntry } from "../../types/index.ts";
import type { ObjectSource } from "../../types/odb.ts";
import type { VirtualEntryKind } from "../core.ts";
import type { BlobObjectMode, NodeOrigin } from "./nodes.ts";

// ==================== 读取 ====================

/**
 * 读取 tree 对象；缺失时抛 VirtualOriginUnavailableError
 */
export function readRepoTree(source: ObjectSource, hash: SHA1, path: string): GitTree {
  const obj = tryReadObject(source, hash);
  if (obj === undefined) {
    throw new VirtualOriginUnavailableError(path, `Origin tree object missing: ${hash}`);
  }
  if (obj.type !== "tree") {
    throw new VirtualOriginUnavailableError(path, `Expected tree at origin, got ${obj.type}`);
  }
  return obj;
}

/**
 * 读取 blob 原始内容；缺失时抛 VirtualOriginUnavailableError
 */
export function readRepoBlobContent(source: ObjectSource, hash: SHA1, path: string): Buffer {
  const obj = tryReadObject(source, hash);
  if (obj === undefined) {
    throw new VirtualOriginUnavailableError(path, `Origin blob object missing: ${hash}`);
  }
  if (obj.type !== "blob") {
    throw new VirtualOriginUnavailableError(path, `Expected blob at origin, got ${obj.type}`);
  }
  return obj.content;
}

/**
 * 根据 tree 条目构造节点 origin
 */
export function treeEntryToNodeOrigin(entry: TreeEntry): NodeOrigin {
  if (entry.mode === "040000") {
    return { kind: "repo-tree", hash: entry.hash };
  }
  if (entry.mode === "100644" || entry.mode === "100755" || entry.mode === "120000") {
    return { kind: "repo-blob", mode: entry.mode, hash: entry.hash };
  }
  return { kind: "repo-blob", mode: "100644", hash: entry.hash };
}

// ==================== 模式辅助 ====================

/**
 * Git mode 转为 VirtualEntryKind
 */
export function modeToVirtualEntryKind(mode: string): VirtualEntryKind {
  if (mode === "040000") {
    return "tree";
  }
  if (mode === "120000") {
    return "symlink";
  }
  return "blob";
}

/**
 * 判断 mode 是否为 blob 类（含可执行与符号链接）
 */
export function isBlobMode(mode: string): mode is BlobObjectMode {
  return mode === "100644" || mode === "100755" || mode === "120000";
}
