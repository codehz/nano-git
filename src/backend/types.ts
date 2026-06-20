/**
 * 仓库后端接口定义
 *
 * Repository 本身只负责高层 Git 语义，
 * 底层对象存储、引用存储和仓库布局信息通过 Backend 注入。
 */

import type { RefStore } from "../refs/types.ts";
import type { ObjectStore } from "../store/types.ts";

/**
 * 仓库后端接口
 *
 * 聚合 Repository 所需的底层依赖：
 * - objects: Git 对象存储
 * - refs: Git 引用存储
 * - gitDir: .git 目录路径（内存仓库为 null）
 */
export interface RepositoryBackend {
  /** Git 对象存储 */
  readonly objects: ObjectStore;

  /** Git 引用存储 */
  readonly refs: RefStore;

  /** .git 目录路径（内存仓库为 null） */
  readonly gitDir: string | null;
}
