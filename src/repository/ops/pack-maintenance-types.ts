/**
 * Pack 仓库维护操作类型定义
 */

import type { RepositoryRepackOptions } from "../../pack/types.ts";
import type { PackBuildResult } from "../../pack/types.ts";
import type { SHA1 } from "../../types/index.ts";

/**
 * 依赖 pack 支持的仓库维护操作
 */
export interface RepositoryPackMaintenanceOperations {
  /** 将指定对象写入新的 packfile */
  writePack(hashes?: SHA1[]): PackBuildResult;

  /** 重写仓库 pack 布局 */
  repack(options?: RepositoryRepackOptions): PackBuildResult;
}
