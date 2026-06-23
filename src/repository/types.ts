/**
 * Git 仓库高层 API 类型定义
 *
 * 组合仓库上下文、对象操作、引用操作与维护操作的总接口。
 *
 * 这些操作对应 git 的 plumbing 命令。
 */

import type { ObjectStore } from "../odb/types.ts";
import type { RefStore } from "../refs/types.ts";
import type { ShallowStore } from "../shallow/types.ts";
import type { RepositoryPackSupport } from "./backend/index.ts";
import type { RepositoryFetchOperations } from "./fetch-types.ts";
import type { RepoImportOperations } from "./import-session-types.ts";
import type { RepositoryMaintenanceOperations } from "./maintenance-types.ts";
import type { RepositoryObjectOperations } from "./object-types.ts";
import type { RepositoryPushOperations } from "./push-types.ts";
import type { RepositoryRefOperations } from "./ref-types.ts";

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
  /** Git 对象存储 */
  readonly objects: ObjectStore;

  /** Git 引用存储 */
  readonly refs: RefStore;

  /** Packfile 支持 */
  readonly packs: RepositoryPackSupport | null;

  /** Git shallow 边界存储 */
  readonly shallow: ShallowStore;

  /** .git 目录路径（内存仓库为 null） */
  readonly gitDir: string | null;
}
