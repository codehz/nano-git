/**
 * Git 仓库高层 API 类型定义
 *
 * 组合仓库上下文、对象操作、引用操作与维护操作的总接口。
 *
 * 这些操作对应 git 的 plumbing 命令。
 */

import type { RepositoryPackSupport } from "../backend/types.ts";
import type { ObjectDatabase } from "../odb/types.ts";
import type { RefStore } from "../types/refs.ts";
import type { ShallowStore } from "../types/shallow.ts";
import type { RepoImportOperations } from "./import/import-session-types.ts";
import type { RepositoryFetchOperations } from "./ops/fetch-types.ts";
import type { RepositoryMaintenanceOperations } from "./ops/maintenance-types.ts";
import type {
  RepositoryFsObjectOperations,
  RepositoryObjectOperations,
} from "./ops/object-types.ts";
import type { RepositoryPushOperations } from "./ops/push-types.ts";
import type { RepositoryRefOperations } from "./ops/ref-types.ts";

/**
 * Git 仓库接口
 */
export interface Repository
  extends
    RepositoryObjectOperations,
    RepositoryRefOperations,
    RepositoryMaintenanceOperations,
    RepositoryPushOperations,
    RepositoryFetchOperations,
    RepoImportOperations {
  /** Git 对象数据库（raw-first） */
  readonly objects: ObjectDatabase;

  /** Git 引用存储 */
  readonly refs: RefStore;

  /** Packfile 支持 */
  readonly packs: RepositoryPackSupport | null;

  /** Git shallow 边界存储 */
  readonly shallow: ShallowStore;

  /** .git 目录路径（内存仓库为 null） */
  readonly gitDir: string | null;
}

/**
 * 带文件系统扩展能力的仓库接口
 */
export interface FileRepository extends Repository, RepositoryFsObjectOperations {
  /** .git 目录路径 */
  readonly gitDir: string;
}
