/**
 * Pack 与文件仓库的能力接口
 */

import type { RepositoryPackSupport } from "../backend/pack.ts";
import type { RepositoryGCOptions } from "../backend/types.ts";
import type { PackBuildResult } from "../pack/types.ts";
import type { RepositoryFsObjectOperations } from "./ops/object-types.ts";
import type { RepositoryPackMaintenanceOperations } from "./ops/pack-maintenance-types.ts";
import type { Repository } from "./types.ts";

/**
 * 具备 packfile 能力的仓库接口
 */
export interface PackRepository extends Repository, RepositoryPackMaintenanceOperations {
  /** Pack 对象源与写入能力 */
  readonly packs: RepositoryPackSupport;

  /** 执行带 pack repack 的 GC */
  gc(options?: RepositoryGCOptions): PackBuildResult;
}

/**
 * 带文件系统扩展能力的仓库接口
 */
export interface FileRepository extends PackRepository, RepositoryFsObjectOperations {
  /** .git 目录路径 */
  readonly gitDir: string;
}
