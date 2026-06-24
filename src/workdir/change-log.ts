/**
 * Virtual Workdir 变更记录（内部格式）
 *
 * 会话层追加操作历史；对外 `listChanges()` 通过 `toVirtualChanges()` 映射为公开类型。
 */

import type { VirtualChange, VirtualChangeType } from "./core.ts";

// ==================== 内部记录 ====================

/** 内部变更操作（含 revert，公开 API 暂不暴露 revert） */
export type InternalChangeRecord =
  | { readonly op: "add"; readonly path: string }
  | { readonly op: "modify"; readonly path: string }
  | { readonly op: "delete"; readonly path: string }
  | { readonly op: "rename"; readonly from: string; readonly to: string }
  | { readonly op: "copy"; readonly from: string; readonly to: string }
  | { readonly op: "revert"; readonly path: string };

/**
 * 会话变更日志
 */
export interface VirtualChangeLog {
  /** 按时间顺序追加 */
  readonly append: (record: InternalChangeRecord) => void;
  /** 清空（如 reset） */
  readonly clear: () => void;
  /** 内部记录快照 */
  readonly snapshot: () => readonly InternalChangeRecord[];
  /** 映射为公开 VirtualChange 列表 */
  readonly toVirtualChanges: () => VirtualChange[];
}

/**
 * 创建空的变更日志
 *
 * @example
 * ```ts
 * const log = createVirtualChangeLog();
 * log.append({ op: "add", path: "a.txt" });
 * expect(log.toVirtualChanges()).toEqual([{ path: "a.txt", type: "add" }]);
 * ```
 */
export function createVirtualChangeLog(): VirtualChangeLog {
  const records: InternalChangeRecord[] = [];

  return {
    append(record: InternalChangeRecord): void {
      records.push(record);
    },
    clear(): void {
      records.length = 0;
    },
    snapshot(): readonly InternalChangeRecord[] {
      return records.slice();
    },
    toVirtualChanges(): VirtualChange[] {
      return mapInternalChangesToVirtualChanges(records);
    },
  };
}

/**
 * 将内部变更记录映射为公开 VirtualChange 列表
 */
export function mapInternalChangesToVirtualChanges(
  records: readonly InternalChangeRecord[],
): VirtualChange[] {
  const out: VirtualChange[] = [];
  for (const record of records) {
    const mapped = mapInternalToVirtual(record);
    if (mapped !== null) {
      out.push(mapped);
    }
  }
  return out;
}

function mapInternalToVirtual(record: InternalChangeRecord): VirtualChange | null {
  switch (record.op) {
    case "add":
      return { path: record.path, type: "add" as VirtualChangeType };
    case "modify":
      return { path: record.path, type: "modify" };
    case "delete":
      return { path: record.path, type: "delete" };
    case "rename":
      return { path: record.to, type: "rename", oldPath: record.from };
    case "copy":
      return { path: record.to, type: "copy", oldPath: record.from };
    case "revert":
      return null;
    default: {
      const _exhaustive: never = record;
      return _exhaustive;
    }
  }
}
