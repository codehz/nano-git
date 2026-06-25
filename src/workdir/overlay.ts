/**
 * 目录层 overlay：addedEntries / deletedNames 合成规则
 *
 * 不依赖 Git ODB；origin 条目由调用方以 `OriginDirectoryChild` 提供。
 */

import type { NodeId } from "./ids.ts";

// ==================== 类型 ====================

/**
 * 目录 overlay 状态（挂在目录 WorkdirNode 上）
 */
export interface DirectoryOverlay {
  /** workdir 新增或覆盖：条目名 -> 绑定的 nodeId */
  readonly addedEntries: Map<string, NodeId>;
  /** workdir 删除的 origin/先前条目名（tombstone） */
  readonly deletedNames: Set<string>;
}

/**
 * 合成目录列表时使用的 origin 子项（懒读取结果的抽象）
 */
export interface OriginDirectoryChild {
  readonly name: string;
  readonly mode: string;
  readonly nodeId: NodeId;
}

/**
 * 合成后的目录子项（名称 + 绑定 nodeId + mode）
 */
export interface MergedDirectoryChild {
  readonly name: string;
  readonly mode: string;
  readonly nodeId: NodeId;
}

// ==================== 工厂 ====================

/**
 * 创建空目录 overlay
 */
export function createEmptyDirectoryOverlay(): DirectoryOverlay {
  return {
    addedEntries: new Map(),
    deletedNames: new Set(),
  };
}

/**
 * 克隆目录 overlay（深拷贝 Map/Set）
 */
export function cloneDirectoryOverlay(overlay: DirectoryOverlay): DirectoryOverlay {
  return {
    addedEntries: new Map(overlay.addedEntries),
    deletedNames: new Set(overlay.deletedNames),
  };
}

// ==================== 合成 ====================

/**
 * 按 RFC 规则合成目录子项列表
 *
 * 1. 从 origin 去掉 deletedNames
 * 2. addedEntries 覆盖同名 origin
 * 3. 仅存在于 addedEntries 的条目追加
 * 4. 按 Git tree 名称排序
 */
export function mergeDirectoryChildren(
  originChildren: readonly OriginDirectoryChild[],
  overlay: DirectoryOverlay,
  addedEntryModes: ReadonlyMap<string, string>,
): MergedDirectoryChild[] {
  const byName = new Map<string, MergedDirectoryChild>();

  for (const child of originChildren) {
    if (overlay.deletedNames.has(child.name)) {
      continue;
    }
    const overrideId = overlay.addedEntries.get(child.name);
    if (overrideId !== undefined) {
      const mode = addedEntryModes.get(child.name) ?? child.mode;
      byName.set(child.name, { name: child.name, mode, nodeId: overrideId });
    } else {
      byName.set(child.name, {
        name: child.name,
        mode: child.mode,
        nodeId: child.nodeId,
      });
    }
  }

  for (const [name, nodeId] of overlay.addedEntries) {
    if (byName.has(name)) {
      continue;
    }
    const mode = addedEntryModes.get(name);
    if (mode === undefined) {
      throw new Error(`Missing mode for added directory entry '${name}'`);
    }
    byName.set(name, { name, mode, nodeId });
  }

  const merged = Array.from(byName.values());
  merged.sort((a, b) => a.name.localeCompare(b.name));
  return merged;
}

// ==================== 变更操作（目录 overlay） ====================

/**
 * 在目录 overlay 中绑定或覆盖条目（create / modify / rename 目标 / copy 目标）
 */
export function overlayBindEntry(
  overlay: DirectoryOverlay,
  name: string,
  nodeId: NodeId,
): DirectoryOverlay {
  const addedEntries = new Map(overlay.addedEntries);
  const deletedNames = new Set(overlay.deletedNames);
  addedEntries.set(name, nodeId);
  deletedNames.delete(name);
  return { addedEntries, deletedNames };
}

/**
 * 在目录 overlay 中删除条目（tombstone；不递归清理子节点存储）
 */
export function overlayTombstoneEntry(overlay: DirectoryOverlay, name: string): DirectoryOverlay {
  const addedEntries = new Map(overlay.addedEntries);
  const deletedNames = new Set(overlay.deletedNames);
  if (addedEntries.has(name)) {
    addedEntries.delete(name);
  } else {
    deletedNames.add(name);
  }
  return { addedEntries, deletedNames };
}

/**
 * 在同一目录内重命名：复用 nodeId，仅改绑定名
 */
export function overlayRenameEntry(
  overlay: DirectoryOverlay,
  fromName: string,
  toName: string,
  nodeId: NodeId,
): DirectoryOverlay {
  let next = overlayTombstoneEntry(overlay, fromName);
  next = overlayBindEntry(next, toName, nodeId);
  return next;
}

/**
 * 判断合成后目录是否包含某条目名
 */
export function mergedDirectoryHasChild(
  originChildren: readonly OriginDirectoryChild[],
  overlay: DirectoryOverlay,
  addedEntryModes: ReadonlyMap<string, string>,
  name: string,
): boolean {
  return mergeDirectoryChildren(originChildren, overlay, addedEntryModes).some(
    (c) => c.name === name,
  );
}

/**
 * 在合成视图中按名称解析 nodeId
 */
export function resolveChildNodeId(
  originChildren: readonly OriginDirectoryChild[],
  overlay: DirectoryOverlay,
  addedEntryModes: ReadonlyMap<string, string>,
  name: string,
): NodeId | null {
  const child = mergeDirectoryChildren(originChildren, overlay, addedEntryModes).find(
    (c) => c.name === name,
  );
  return child?.nodeId ?? null;
}
