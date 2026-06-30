/**
 * 目录 overlay 的持久化编解码（file manifest / SQLite 共用 JSON 形态）
 */

import type { NodeId } from "../../model/ids.ts";
import type { DirectoryOverlay } from "../../model/overlay.ts";

/** 磁盘 / SQLite 中的 overlay JSON 结构 */
export interface PersistedDirectoryOverlayPayload {
  readonly addedEntries: Array<[string, string]>;
  readonly deletedNames: string[];
}

/**
 * 将 overlay 序列化为可 JSON 化的载荷。
 *
 * @example
 * ```ts
 * const json = JSON.stringify(serializeDirectoryOverlayPayload(overlay));
 * expect(json).toContain("addedEntries");
 * ```
 */
export function serializeDirectoryOverlayPayload(
  overlay: DirectoryOverlay,
): PersistedDirectoryOverlayPayload {
  return {
    addedEntries: Array.from(overlay.addedEntries.entries()),
    deletedNames: Array.from(overlay.deletedNames.values()),
  };
}

/**
 * 从 JSON 字符串或已解析对象恢复 overlay。
 */
export function parseDirectoryOverlay(
  raw: string | PersistedDirectoryOverlayPayload | null,
): DirectoryOverlay {
  if (raw === null) {
    return { addedEntries: new Map(), deletedNames: new Set() };
  }

  const parsed: unknown =
    typeof raw === "string"
      ? ((): unknown => {
          try {
            return JSON.parse(raw);
          } catch (error) {
            throw new Error(
              `Invalid worktree directory overlay JSON: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })()
      : raw;

  if (!isPersistedDirectoryOverlayPayload(parsed)) {
    throw new Error("Invalid worktree directory overlay payload");
  }

  return {
    addedEntries: new Map(parsed.addedEntries.map(([name, nodeId]) => [name, nodeId as NodeId])),
    deletedNames: new Set(parsed.deletedNames),
  };
}

function isPersistedDirectoryOverlayPayload(
  value: unknown,
): value is PersistedDirectoryOverlayPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const maybe = value as {
    addedEntries?: unknown;
    deletedNames?: unknown;
  };
  if (!Array.isArray(maybe.addedEntries) || !Array.isArray(maybe.deletedNames)) {
    return false;
  }

  const hasValidAddedEntries = maybe.addedEntries.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "string" &&
      typeof entry[1] === "string",
  );
  const hasValidDeletedNames = maybe.deletedNames.every((name) => typeof name === "string");
  return hasValidAddedEntries && hasValidDeletedNames;
}
