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

import type { SHA1 } from "../../types/index.ts";
import type { ObjectDatabase } from "../../types/odb.ts";
import type { InitializeVirtualWorktreeOptions, VirtualWorktree } from "../core.ts";

/** 打开 SQLite VirtualWorktree 数据库的可选参数 */
export interface OpenSqliteVirtualWorktreeDatabaseOptions {
  /** 开启 WAL 模式，默认 `true` */
  readonly walMode?: boolean;
}

/** 数据库内单个 VirtualWorktree 条目的摘要 */
export interface SqliteVirtualWorktreeEntrySummary {
  /** 在数据库中唯一标识该 worktree 的 key */
  readonly key: string;
  /** 创建或重置时记录的基准树对象哈希 */
  readonly baseTree: SHA1;
}

/**
 * 单个 SQLite 文件上的 VirtualWorktree 集合管理器
 *
 * 持有数据库连接与共享 prepared statements；`openWorktree` 返回的实例不单独释放连接。
 * 使用 `[Symbol.dispose]()` 或 `using` 在作用域结束时释放连接。
 */
export interface SqliteVirtualWorktreeDatabase {
  /** 打开时使用的 SQLite 数据库文件路径（含 `:memory:` 等特殊路径） */
  readonly dbPath: string;
  /**
   * 列举 worktree key
   *
   * @param prefix - 可选；传入时仅返回以该前缀开头的 key（按字典序）
   */
  listWorktreeKeys(prefix?: string): readonly string[];
  /**
   * 列举 worktree 摘要
   *
   * @param prefix - 可选；传入时仅返回以该前缀开头的条目
   */
  listWorktrees(prefix?: string): readonly SqliteVirtualWorktreeEntrySummary[];
  /**
   * 判断指定 key 的 worktree 是否已存在
   *
   * @param worktreeKey - worktree 唯一标识
   */
  hasWorktree(worktreeKey: string): boolean;
  /**
   * 新建并初始化一个 VirtualWorktree（写入基准树并校验完整性）
   *
   * @param worktreeKey - 新 worktree 的唯一 key
   * @param options - 至少包含 `baseTree`
   * @throws 若 `worktreeKey` 已存在
   */
  createWorktree(worktreeKey: string, options: InitializeVirtualWorktreeOptions): void;
  /**
   * 删除指定 worktree 及其节点、变更记录
   *
   * @param worktreeKey - 要删除的 worktree key
   * @throws 若 worktree 不存在
   */
  deleteWorktree(worktreeKey: string): void;
  /**
   * 将已有 worktree 的 key 从 `fromKey` 改为 `toKey`
   *
   * `fromKey` 与 `toKey` 相同时无操作；重命名后会校验目标 key 的数据完整性。
   *
   * @param fromKey - 当前 key
   * @param toKey - 新 key
   */
  renameWorktree(fromKey: string, toKey: string): void;
  /**
   * 删除所有 key 以 `prefix` 开头的 worktree（含节点与变更表）
   *
   * @param prefix - key 前缀
   * @returns 实际删除的 worktree 数量
   */
  deleteWorktreesByPrefix(prefix: string): number;
  /**
   * 打开已持久化的 VirtualWorktree，在内存中挂载为可读写实例
   *
   * `baseTree` 从数据库读取，无需调用方传入。
   *
   * @param source - 用于解析树/ blob 等对象的 ODB（通常为仓库 `objects`）
   * @param worktreeKey - 已存在的 worktree key
   * @returns 绑定同一数据库连接的 VirtualWorktree 实例
   * @throws 若 worktree 不存在或完整性校验失败
   */
  openWorktree(source: ObjectDatabase, worktreeKey: string): VirtualWorktree;
  /** 释放数据库连接；重复调用安全 */
  [Symbol.dispose](): void;
}

/**
 * 打开 SQLite 文件上的 VirtualWorktree 数据库管理器
 *
 * 若文件不存在会创建；首次打开会初始化 worktree 相关表结构。
 * 返回实例附带 `[Symbol.dispose]()`，推荐配合 `using` 管理生命周期。
 *
 * @param dbPath - SQLite 数据库路径（可使用 `:memory:`）
 * @param options - 连接选项（如 WAL）
 * @returns 多 worktree 集合管理器
 *
 * @example
 * ```ts
 * using db = openSqliteVirtualWorktreeDatabase("/tmp/worktrees.sqlite");
 * db.createWorktree("demo", { baseTree: tree });
 * const worktree = db.openWorktree(repo.objects, "demo");
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

    createWorktree(worktreeKey: string, createOptions: InitializeVirtualWorktreeOptions): void {
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

    openWorktree(source: ObjectDatabase, worktreeKey: string): VirtualWorktree {
      if (!layer.hasWorktree(worktreeKey)) {
        throw new Error(`Virtual worktree not found: ${worktreeKey}`);
      }
      layer.validateWorktreeIntegrity(worktreeKey);
      return openVirtualWorktree(source, layer.bindStateStore(worktreeKey));
    },

    [Symbol.dispose](): void {
      releaseOnce();
    },
  };
}
