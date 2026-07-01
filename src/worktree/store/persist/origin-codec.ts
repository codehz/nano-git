/**
 * Worktree 节点 origin 的持久化编解码
 */

import type { SHA1 } from "../../../types/index.ts";
import type { WorktreeNode } from "../../model/nodes.ts";

/** 文件 manifest 中的 origin 记录 */
export type PersistedNodeOriginRecord =
  | { readonly kind: "none" }
  | { readonly kind: "repo-tree"; readonly hash: string }
  | {
      readonly kind: "repo-blob";
      readonly mode: "100644" | "100755" | "120000";
      readonly hash: string;
    };

/**
 * 从 manifest 形态恢复 origin。
 */
export function parseNodeOrigin(record: PersistedNodeOriginRecord): WorktreeNode["origin"] {
  if (record.kind === "none") {
    return { kind: "none" };
  }
  if (record.kind === "repo-tree") {
    if (record.hash.length === 0) {
      throw new Error("Invalid worktree node: repo-tree origin is missing hash");
    }
    return { kind: "repo-tree", hash: record.hash as SHA1 };
  }
  return {
    kind: "repo-blob",
    mode: record.mode,
    hash: record.hash as SHA1,
  };
}

/**
 * 从 SQLite 列恢复 origin。
 */
export function parseNodeOriginFromSqliteColumns(
  originKind: string,
  originHash: string | null,
  originMode: string | null,
): WorktreeNode["origin"] {
  if (originKind === "none") {
    return { kind: "none" };
  }

  if (originKind === "repo-tree") {
    if (originHash === null) {
      throw new Error("Invalid SQLite worktree node: repo-tree origin is missing hash");
    }
    return { kind: "repo-tree", hash: originHash as SHA1 };
  }

  if (originKind === "repo-blob") {
    if (originHash === null) {
      throw new Error("Invalid SQLite worktree node: repo-blob origin is missing hash");
    }
    if (originMode !== "100644" && originMode !== "100755" && originMode !== "120000") {
      throw new Error(`Invalid SQLite worktree node origin mode: ${originMode ?? "null"}`);
    }
    return {
      kind: "repo-blob",
      mode: originMode,
      hash: originHash as SHA1,
    };
  }

  throw new Error(`Invalid SQLite worktree node origin kind: ${originKind}`);
}
