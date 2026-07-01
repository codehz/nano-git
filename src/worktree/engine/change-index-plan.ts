/**
 * Virtual Worktree change-index 刷新策略
 *
 * 把 worktree 写路径里的“是否允许增量刷新”判断与
 * “应该执行哪种 change-index 更新动作”集中到单独模块。
 */

import { resolvePath } from "./worktree-path.ts";

import type { ObjectSource } from "../../types/odb.ts";
import type { VirtualWorktreeStateStore } from "../store/state-store.ts";

/**
 * change-index 更新计划
 */
export type ChangeIndexUpdatePlan =
  | { readonly kind: "rebuild-all" }
  | { readonly kind: "refresh-path"; readonly path: string };

/**
 * path 增量刷新判定选项
 */
export interface ChangeIndexPathRefreshOptions {
  /** 路径当前缺失时，是否仍允许按“单路径增量”处理 */
  readonly treatMissingAsIncremental?: boolean;
}

/**
 * change-index 刷新动作集合
 */
export interface ChangeIndexUpdateActions {
  rebuildAll(): void;
  refreshPath(path: string): void;
}

/**
 * change-index 刷新策略器
 */
export interface ChangeIndexPlanner {
  apply(plan: ChangeIndexUpdatePlan): void;
  planRefreshForPath(path: string, options?: ChangeIndexPathRefreshOptions): ChangeIndexUpdatePlan;
  planDeletePath(path: string, options?: ChangeIndexPathRefreshOptions): ChangeIndexUpdatePlan;
  /** move 当前总是回退到全量重建。 */
  planMove(from: string, to: string): ChangeIndexUpdatePlan;
  /** copy 当前总是回退到全量重建。 */
  planCopy(from: string, to: string): ChangeIndexUpdatePlan;
}

/**
 * 创建 change-index 刷新策略器。
 *
 * @example
 * ```ts
 * const planner = createChangeIndexPlanner(source, state, {
 *   rebuildAll() {},
 *   refreshPath() {},
 * });
 * expect(planner.planRefreshForPath("a.txt").kind).toBe("refresh-path");
 * ```
 */
export function createChangeIndexPlanner(
  source: ObjectSource,
  state: VirtualWorktreeStateStore,
  actions: ChangeIndexUpdateActions,
): ChangeIndexPlanner {
  const canIncrementallyRefreshPath = (
    path: string,
    options?: ChangeIndexPathRefreshOptions,
  ): boolean => {
    const resolved = resolvePath(source, state, path);
    if (!resolved.found || resolved.node === null) {
      return options?.treatMissingAsIncremental === true;
    }
    return resolved.node.state.kind !== "directory";
  };

  return {
    apply(plan): void {
      switch (plan.kind) {
        case "rebuild-all":
          actions.rebuildAll();
          return;
        case "refresh-path":
          actions.refreshPath(plan.path);
          return;
      }
    },

    planRefreshForPath(path, options): ChangeIndexUpdatePlan {
      return canIncrementallyRefreshPath(path, options)
        ? { kind: "refresh-path", path }
        : { kind: "rebuild-all" };
    },

    planDeletePath(path, options): ChangeIndexUpdatePlan {
      return canIncrementallyRefreshPath(path)
        ? { kind: "refresh-path", path }
        : canIncrementallyRefreshPath(path, options)
          ? { kind: "refresh-path", path }
          : { kind: "rebuild-all" };
    },

    planMove(from, to): ChangeIndexUpdatePlan {
      void from;
      void to;
      return { kind: "rebuild-all" };
    },

    planCopy(from, to): ChangeIndexUpdatePlan {
      void from;
      void to;
      return { kind: "rebuild-all" };
    },
  };
}
