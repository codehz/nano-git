/**
 * Virtual Worktree SQLite 公开入口
 */

import { acquireConnection } from "../../backend/sqlite-pool.ts";
import { openVirtualWorktree } from "../engine/worktree.ts";
import {
  createSqliteVirtualWorktreeDbLayer,
  ensureWorktreeSqliteSchema,
  readBaseTreeValue,
} from "./sqlite-db-layer.ts";

import type { SHA1 } from "../../core/types.ts";
import type { ObjectDatabase } from "../../core/types/odb.ts";
import type { CreateVirtualWorktreeOptions, VirtualWorktree } from "../core.ts";

/** 打开 SQLite VirtualWorktree 数据库的可选参数 */
export interface OpenSqliteVirtualWorktreeDatabaseOptions {
  /** 开启 WAL 模式，默认 true */
  readonly walMode?: boolean;
}

/** 数据库内单个 VirtualWorktree 条目的摘要 */
export interface SqliteVirtualWorktreeEntrySummary {
  readonly key: string;
  readonly baseTree: SHA1;
}

/**
 * 单个 SQLite 文件上的 VirtualWorktree 集合管理器
 *
 * 持有数据库连接与共享 prepared statements；`openWorktree` 返回的实例不单独释放连接。
 */
export interface SqliteVirtualWorktreeDatabase {
  readonly dbPath: string;
  /**
   * 列举 worktree key；传入 `prefix` 时仅返回以该前缀开头的 key（按字典序）
   */
  listWorktreeKeys(prefix?: string): readonly string[];
  /**
   * 列举 worktree 摘要；传入 `prefix` 时仅返回以该前缀开头的条目
   */
  listWorktrees(prefix?: string): readonly SqliteVirtualWorktreeEntrySummary[];
  hasWorktree(worktreeKey: string): boolean;
  createWorktree(worktreeKey: string, options: CreateVirtualWorktreeOptions): void;
  deleteWorktree(worktreeKey: string): void;
  /**
   * 将已有 worktree 的 key 从 `fromKey` 改为 `toKey`（`fromKey` 与 `toKey` 相同时无操作）
   */
  renameWorktree(fromKey: string, toKey: string): void;
  /**
   * 删除所有 key 以 `prefix` 开头的 worktree（含节点与变更表），返回删除数量
   */
  deleteWorktreesByPrefix(prefix: string): number;
  openWorktree(
    source: ObjectDatabase,
    worktreeKey: string,
    options: CreateVirtualWorktreeOptions,
  ): VirtualWorktree;
  [Symbol.dispose](): void;
}

/**
 * 打开 SQLite 文件上的 VirtualWorktree 数据库管理器
 *
 * @example
 * ```ts
 * using db = openSqliteVirtualWorktreeDatabase("/tmp/worktrees.sqlite");
 * db.createWorktree("demo", { baseTree: tree });
 * const worktree = db.openWorktree(repo.objects, "demo", { baseTree: tree });
 * expect(db.listWorktreeKeys()).toEqual(["demo"]);
 * ```
 */
export function openSqliteVirtualWorktreeDatabase(
  dbPath: string,
  options: OpenSqliteVirtualWorktreeDatabaseOptions = {},
): SqliteVirtualWorktreeDatabase {
  const conn = acquireConnection(dbPath, options.walMode !== false);
  let released = false;

  const releaseOnce = (): void => {
    if (released) {
      return;
    }
    released = true;
    conn.release();
  };

  try {
    ensureWorktreeSqliteSchema(conn.db);
  } catch (error) {
    releaseOnce();
    throw error;
  }

  const layer = createSqliteVirtualWorktreeDbLayer(conn);

  return {
    dbPath,

    listWorktreeKeys(prefix?: string): readonly string[] {
      return layer.listWorktreeKeys(prefix);
    },

    listWorktrees(prefix?: string): readonly SqliteVirtualWorktreeEntrySummary[] {
      return layer.listWorktreeRows(prefix).map((row) => ({
        key: row.worktree_key,
        baseTree: readBaseTreeValue(row.base_tree),
      }));
    },

    hasWorktree(worktreeKey: string): boolean {
      return layer.hasWorktree(worktreeKey);
    },

    createWorktree(worktreeKey: string, createOptions: CreateVirtualWorktreeOptions): void {
      if (layer.hasWorktree(worktreeKey)) {
        throw new Error(`Virtual worktree already exists: ${worktreeKey}`);
      }
      const store = layer.bindStateStore(worktreeKey);
      store.reset(createOptions.baseTree);
      layer.validateWorktreeIntegrity(worktreeKey);
    },

    deleteWorktree(worktreeKey: string): void {
      if (!layer.hasWorktree(worktreeKey)) {
        throw new Error(`Virtual worktree not found: ${worktreeKey}`);
      }
      layer.deleteWorktree(worktreeKey);
    },

    renameWorktree(fromKey: string, toKey: string): void {
      layer.renameWorktree(fromKey, toKey);
      if (fromKey !== toKey) {
        layer.validateWorktreeIntegrity(toKey);
      }
    },

    deleteWorktreesByPrefix(prefix: string): number {
      return layer.deleteWorktreesByPrefix(prefix);
    },

    openWorktree(
      source: ObjectDatabase,
      worktreeKey: string,
      openOptions: CreateVirtualWorktreeOptions,
    ): VirtualWorktree {
      if (!layer.hasWorktree(worktreeKey)) {
        throw new Error(`Virtual worktree not found: ${worktreeKey}`);
      }
      layer.validateWorktreeIntegrity(worktreeKey);
      const worktree = openVirtualWorktree(source, layer.bindStateStore(worktreeKey));
      if (worktree.baseTree !== openOptions.baseTree) {
        throw new Error(
          `Virtual worktree baseTree mismatch for ${worktreeKey}: expected ${openOptions.baseTree}, got ${worktree.baseTree}`,
        );
      }
      return worktree;
    },

    [Symbol.dispose](): void {
      releaseOnce();
    },
  };
}
