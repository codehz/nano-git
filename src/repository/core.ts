/**
 * 通用仓库入口
 *
 * 仅包含与文件系统无关的仓库拼装逻辑。
 */

export { createRepository } from "./create.ts";
export type { Repository, FileRepository } from "./types.ts";
export type {
  DiffEntry,
  DiffChanges,
  DiffObject,
  DiffObjectKind,
  DiffObjectMode,
} from "../diff.ts";
export type { TreeSnapshotEntry } from "./tree/tree-diff.ts";
