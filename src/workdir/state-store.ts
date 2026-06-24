/**
 * Virtual Workdir 内部状态存储抽象
 *
 * 供 session 编排层、路径解析层、write-tree 共享使用。
 * 目标是让 memory / file / sqlite backend 复用同一套行为逻辑。
 */

import type { SHA1 } from "../core/types.ts";
import type { NormalizedChangeRecord } from "./change-index.ts";
import type { DirtyDirSummary } from "./dirty-dir.ts";
import type { NodeId } from "./ids.ts";
import type { SessionNode } from "./nodes.ts";

/**
 * Virtual Workdir 内部状态存储接口
 */
export interface VirtualWorkdirStateStore {
  /** 后端类型 */
  readonly kind: "memory" | "file" | "sqlite";

  /**
   * 在单次提交边界内执行状态变更
   *
   * 用于把一次 session 写操作封装为单个内部事务。
   * 若回调抛错，store 应尽力恢复到调用前状态。
   */
  transact<T>(fn: () => T): T;

  /** 读取当前基线 tree */
  readBaseTree(): SHA1;

  /** 覆盖当前基线 tree */
  writeBaseTree(baseTree: SHA1): void;

  /** 读取节点，不存在时返回 null */
  getNode(id: NodeId): SessionNode | null;

  /** 写入或覆盖节点 */
  setNode(node: SessionNode): void;

  /** 删除节点 */
  deleteNode(id: NodeId): void;

  /** 列出全部规范化变更记录 */
  listChangeRecords(): readonly NormalizedChangeRecord[];

  /** 按路径读取规范化变更记录 */
  getChangeRecord(path: string): NormalizedChangeRecord | null;

  /** 写入或覆盖规范化变更记录 */
  setChangeRecord(record: NormalizedChangeRecord): void;

  /** 删除规范化变更记录 */
  deleteChangeRecord(path: string): void;

  /** 列出全部脏目录摘要 */
  listDirtyDirSummaries(): readonly DirtyDirSummary[];

  /** 按目录路径读取脏目录摘要 */
  getDirtyDirSummary(path: string): DirtyDirSummary | null;

  /** 写入或覆盖脏目录摘要 */
  setDirtyDirSummary(summary: DirtyDirSummary): void;

  /** 删除脏目录摘要 */
  deleteDirtyDirSummary(path: string): void;

  /**
   * 重置为新的基线 tree
   *
   * 需要同时清空节点状态，并重新建立根节点。
   */
  reset(baseTree: SHA1): void;
}
