/**
 * Virtual Workdir dirty-dir summary 重建策略
 *
 * 把 session 写路径里的脏目录摘要清理与重建逻辑集中到单独模块，
 * 让 session.ts 更接近纯编排层。
 */

import { observeDirectoryChildren } from "./directory-view.ts";
import { createDirtyDirSummary, type DirtyDirSummary } from "./dirty-dir.ts";
import { VIRTUAL_ROOT_PATH } from "./path.ts";
import { getRootNode } from "./session-internal.ts";

import type { ObjectSource } from "../core/types/odb.ts";
import type { SessionNode } from "./nodes.ts";
import type { VirtualWorkdirStateStore } from "./state-store.ts";

/**
 * dirty-dir summary 策略器
 */
export interface DirtyDirPlanner {
  clear(): void;
  rebuild(touchedPaths: readonly string[]): void;
}

/**
 * 创建 dirty-dir summary 策略器。
 *
 * @example
 * ```ts
 * const planner = createDirtyDirPlanner(source, state);
 * planner.rebuild(["src/index.ts"]);
 * ```
 */
export function createDirtyDirPlanner(
  source: ObjectSource,
  state: VirtualWorkdirStateStore,
): DirtyDirPlanner {
  return {
    clear(): void {
      for (const summary of state.listDirtyDirSummaries()) {
        state.deleteDirtyDirSummary(summary.path);
      }
    },

    rebuild(touchedPaths): void {
      const nextSummaries = new Map<string, DirtyDirSummary>();
      const invalidatedDirPaths = collectInvalidatedSummaryPaths(touchedPaths);

      const visitDirectory = (node: SessionNode, dirPath: string): number => {
        if (node.state.kind !== "directory") {
          throw new Error(`rebuildDirtyDirectorySummaries: '${dirPath}' is not a directory`);
        }

        const { affectedNames, dirtyDescendantCount } = observeDirectoryChildren(
          source,
          state,
          node,
          dirPath,
          {
            onDirectoryChild(child) {
              return visitDirectory(child.node, child.path);
            },
            isLeafChildDirty(child) {
              return state.getChangeRecord(child.path) !== null;
            },
          },
        );

        if (affectedNames.size === 0 && dirtyDescendantCount === 0) {
          return 0;
        }

        const existing = state.getDirtyDirSummary(dirPath);
        const preserveHash = existing !== null && !invalidatedDirPaths.has(dirPath);
        nextSummaries.set(dirPath, {
          ...createDirtyDirSummary(dirPath, Array.from(affectedNames)),
          dirtyDescendantCount,
          currentTreeHash: preserveHash ? existing.currentTreeHash : null,
          hashState: preserveHash ? existing.hashState : "stale",
        });
        return affectedNames.size + dirtyDescendantCount;
      };

      visitDirectory(getRootNode(state), VIRTUAL_ROOT_PATH);

      for (const summary of state.listDirtyDirSummaries()) {
        if (!nextSummaries.has(summary.path)) {
          state.deleteDirtyDirSummary(summary.path);
        }
      }
      for (const summary of nextSummaries.values()) {
        state.setDirtyDirSummary(summary);
      }
    },
  };
}

function collectInvalidatedSummaryPaths(paths: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const path of paths) {
    out.add(path);
    let cursor = path;
    while (true) {
      const slashIndex = cursor.lastIndexOf("/");
      if (slashIndex < 0) {
        out.add(VIRTUAL_ROOT_PATH);
        break;
      }
      cursor = cursor.slice(0, slashIndex);
      out.add(cursor);
    }
  }
  return out;
}
