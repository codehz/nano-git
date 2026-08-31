/**
 * 核心仓库后端接口定义
 *
 * Repository 本身只负责高层 Git 语义，
 * 底层对象存储、引用存储和仓库布局信息通过 Backend 注入。
 * Pack 能力通过 `RepositoryPackBackend` 独立扩展。
 */

import type { ObjectDatabase } from "../odb/types.ts";
import type { RefStore, RefTransactionHook } from "../types/refs.ts";
import type { ShallowStore } from "../types/shallow.ts";

/** 仓库级 gc 选项 */
export interface RepositoryGCOptions {
  /** 是否删除不可达的 loose objects，默认 true */
  readonly pruneLoose?: boolean;

  /** 有 pack 能力时是否替换旧 pack，核心仓库忽略此选项 */
  readonly replaceExistingPacks?: boolean;
}

/**
 * 仓库后端接口
 *
 * 聚合核心 Repository 所需的底层依赖：
 * - objects: Git 对象存储
 * - refs: Git 引用存储
 * - shallow: Git shallow 边界存储
 * - gitDir: .git 目录路径（内存仓库为 null）
 */
export interface RepositoryBackend {
  /** Git 对象数据库（raw-first） */
  readonly objects: ObjectDatabase;

  /** Git 引用存储 */
  readonly refs: RefStore;

  /** Git shallow 边界存储 */
  readonly shallow: ShallowStore;

  /** .git 目录路径（内存仓库为 null） */
  readonly gitDir: string | null;

  /** Reference transaction hooks（可选） */
  readonly refTransactionHooks?: RefTransactionHook[];
}
